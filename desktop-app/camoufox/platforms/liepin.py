#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
猎聘（Liepin）平台模块 —— 搜索 / 投递 / 扫码登录
============================================
口径来源：get_jobs(loks666) Liepin.java + Auto-JobHunter(jolie-z) liepin_crawler.py
  - 搜索 URL：https://www.liepin.com/zhaopin/?city=&dq=&salary=&currentPage=0&key=
  - 数据源：接口 com.liepin.searchfront4c.pc-search-job（on_response 拦截 JSON，
    data.data.jobCardList，每项含 job / comp / recruiter 子对象）；DOM 卡片兜底
  - 投递：卡片/详情页点「聊一聊」→ 平台用 App 预设招呼语自动发送 → 聊天窗打开
    → 按钮态变「继续聊」= 已建立会话（成功判定，对齐「未确认不计成功」不变量）
  - 安全：不注入招呼语文本（App 预设）；code 35/36/32 类风控立即停止交人工
"""
import re
import time

from .common import (
    log, human_sleep, human_delay, open_browser, load_cookies, save_cookies,
    goto_stable, risk_text_hit,
)
from .filters import build_filter_params, normalize_criteria, summarize_applied

PLATFORM = 'liepin'

# 城市码（Auto-JobHunter 实测 + get_jobs 配置口径）
CITY_CODES = {
    '全国': '410', '北京': '010', '上海': '020', '天津': '030', '重庆': '040',
    '广州': '050020', '深圳': '050090', '杭州': '070020', '成都': '280020',
    '武汉': '170020', '南京': '060020', '苏州': '060080',
}
# 薪资码（年薪档：10万以下=1 … 50万以上=7）
SALARY_CODES = {
    '10万以下': '1', '10-15万': '2', '15-20万': '3', '20-30万': '4',
    '30-40万': '5', '40-50万': '6', '50万以上': '7',
}
SEARCH_API_HINT = 'com.liepin.searchfront4c.pc-search-job'

# 沟通按钮文本（卡片/详情页）：聊一聊 / 和TA聊聊 / 与TA聊聊 / 继续聊
CHAT_BTN_RE = re.compile(r'聊\s*一\s*聊|和\s*TA\s*聊聊|与\s*TA\s*聊聊|和\s*他\s*聊聊|和\s*她\s*聊聊|继续\s*聊')
# 已建立会话的按钮态
CONTINUE_CHAT_RE = re.compile(r'继续\s*聊')
# 登录页判定（扫码后跳离即成功）
LOGIN_LEAVE_RE = re.compile(r'/login|passport|security|verify', re.I)
# 外部网申（猎聘无此概念，保留占位）
EXTERNAL_RE = re.compile(r'立即\s*网申|去\s*网申|前往\s*申请|申请\s*职位')


def _resolve_city(city: str) -> str:
    c = str(city or '').strip()
    if not c or c in ('不限', '全部', '全国'):
        return CITY_CODES['全国']
    if c in CITY_CODES:
        return CITY_CODES[c]
    for name, code in CITY_CODES.items():
        if name.startswith(c) or c.startswith(name):
            return code
    return CITY_CODES['全国']


def _resolve_salary(salary: str) -> str:
    s = str(salary or '').strip()
    if not s or s in ('不限', '全部'):
        return ''
    if re.fullmatch(r'\d{1,2}', s):
        return s
    return SALARY_CODES.get(s, '')


def build_search_url(query: str, city: str, salary: str, page: int = 1,
                     criteria: dict | None = None) -> str:
    """猎聘搜索 URL：城市 / 薪资 / 关键词 + 「基础求职条件」映射的经验·学历参数。

    criteria 为设置页「基础求职条件」（全平台共用），经 filters.build_filter_params
    翻译成本平台参数（workYearCode / eduLevel；compScale·jobKind 码值未验证不附加）。
    """
    code = _resolve_city(city)
    sal = _resolve_salary(salary or ((criteria or {}).get('salary') or ''))
    url = (f"https://www.liepin.com/zhaopin/?city={code}&dq={code}"
           f"&currentPage={max(0, page - 1)}")
    if sal:
        url += f"&salary={sal}"
    q = str(query or '').strip()
    if q:
        url += f"&key={q}"
    for k, v in build_filter_params(PLATFORM, criteria).items():
        url += f"&{k}={v}"
    return url


def format_jobs(raw: list) -> list:
    """猎聘 jobCardList → Boss-claw JobMeta 兼容结构。"""
    out = []
    for item in raw:
        job = item.get('job') or {}
        comp = item.get('comp') or {}
        recruiter = item.get('recruiter') or {}
        job_id = job.get('jobId') or item.get('jobId') or ''
        if not job_id:
            continue
        link = job.get('link') or ''
        if link and not link.startswith('http'):
            link = 'https://www.liepin.com' + link
        out.append({
            "platform": PLATFORM,
            "jobId": str(job_id),
            "title": job.get('title') or '',
            "company": comp.get('compName') or '',
            "salary": job.get('salary') or '',
            "location": job.get('dq') or '',
            "experience": job.get('requireWorkYears') or '',
            "degree": job.get('requireEduLevel') or '',
            "labels": [],
            "skills": [],
            "description": '',
            "recruiterName": recruiter.get('recruiterName') or '',
            "bossTitle": recruiter.get('recruiterTitle') or '',
            "companySize": comp.get('compScale') or '',
            "companyType": comp.get('compIndustry') or '',
            "url": link,
        })
    return out


def search_jobs(query: str, city: str, pages: int = 1, os_name: str | None = None,
                criteria: dict | None = None) -> dict:
    """猎聘隐身搜索：访问搜索页 + 拦截 pc-search-job 接口 JSON + DOM 卡片兜底。

    criteria = 设置页「基础求职条件」（全平台共用），映射见 filters.py。
    """
    c = normalize_criteria(criteria)
    applied = summarize_applied(PLATFORM, build_filter_params(PLATFORM, criteria))
    log('🔍', f'[liepin] 搜索：{query} / city={city} / pages={pages}'
             + (f' / 已应用：{applied}' if applied else ''))
    all_jobs = []
    last_code = 0
    last_msg = ''

    with open_browser(os_name=os_name) as page:
        cookies = load_cookies(PLATFORM)
        if cookies:
            try:
                page.context.add_cookies(cookies)
            except Exception as e:
                log('⚠️', f'[liepin] 注入 Cookie 失败：{e}')

        captured = []  # 接口拦截到的原始卡片

        def on_response(response):
            try:
                if response.status != 200:
                    return
                u = response.url or ''
                if SEARCH_API_HINT in u and 'cond-init' not in u:
                    ctype = (response.headers.get('content-type') or '')
                    if 'json' not in ctype and ctype:
                        return
                    text = response.text()
                    if text:
                        import json as _json
                        root = _json.loads(text)
                        card_list = (root.get('data') or {}).get('data') or {}
                        card_list = card_list.get('jobCardList') if isinstance(card_list, dict) else None
                        if not card_list:
                            card_list = ((root.get('data') or {}).get('jobCardList') or [])
                        if isinstance(card_list, list) and card_list:
                            captured.extend(card_list)
            except Exception:
                pass

        page.on("response", on_response)

        for page_num in range(1, pages + 1):
            url = build_search_url(query, city, c['salary'], page_num, criteria)
            log('📄', f'[liepin] Page {page_num}: {url}')
            if not goto_stable(page, url, wait=2.5):
                log('❌', '[liepin] 页面未稳定（可能被反爬拦截）')
                last_code, last_msg = 37, 'liepin 页面加载失败'
                break
            risk = risk_text_hit(page)
            if risk:
                log('🚫', f'[liepin] 风控：{risk} — 停止')
                last_code, last_msg = 35, f'风控：{risk}'
                break
            # 等待卡片与接口数据
            for _ in range(6):
                if captured:
                    break
                time.sleep(1.5)
            # 接口数据不足时 DOM 兜底
            dom_jobs = _collect_dom_cards(page)
            all_jobs.extend(format_jobs(captured) if captured else [])
            if dom_jobs and not captured:
                all_jobs.extend(dom_jobs)
            captured = []
            log('✅', f'[liepin] Page {page_num}: {len(all_jobs)} 个岗位')
            if page_num < pages:
                human_sleep(3 + (page_num % 3), 0.4, 1.5)

    if last_code in (35, 36, 32, 37):
        return {"ok": False, "code": last_code, "message": last_msg, "jobs": []}
    return {"ok": True, "code": 0, "jobs": all_jobs}


def _collect_dom_cards(page) -> list:
    """DOM 卡片兜底提取（接口拦截失败时用）。"""
    try:
        return page.evaluate("""() => {
            const out = [];
            const text = (el) => (el.textContent || '').trim().replace(/\\s+/g, ' ');
            const cards = Array.from(document.querySelectorAll('li[data-tlg-ext], .job-card, [class*="job-card"], [class*="jobCard"], li'));
            const seen = new Set();
            for (const c of cards) {
                if (seen.has(c)) continue; seen.add(c);
                const t = text(c);
                if (!t || t.length < 10 || t.length > 900) continue;
                let jobId = '';
                try { const ext = c.getAttribute('data-tlg-ext') || ''; const m = ext.match(/jobId[\\\\":=]+(\\d+)/); if (m) jobId = m[1]; } catch(e) {}
                if (!jobId) { try { const a = c.querySelector('a[href*="/job/"]'); if (a && a.href) { const m = a.href.match(/job[\\\\/]*(\\d+)/); if (m) jobId = m[1]; } } catch(e) {} }
                if (!jobId) continue;
                const a = c.querySelector('a[href*="/job/"]');
                out.push({
                    platform: 'liepin',
                    jobId: String(jobId),
                    title: text(c.querySelector('[class*="job-title"], [class*="ellipsis-1"], h3') || c).slice(0, 120) || '岗位',
                    company: text(c.querySelector('[class*="company"], [class*="comp-name"]') || c).slice(0, 80) || '',
                    salary: text(c.querySelector('[class*="salary"], [class*="job-salary"]') || c).slice(0, 40) || '',
                    location: text(c.querySelector('[class*="area"], [class*="dq"], [class*="address"]') || c).slice(0, 60) || '',
                    experience: '', degree: '', labels: [], skills: [], description: '',
                    recruiterName: text(c.querySelector('[class*="recruiter"], [class*="hr-name"], [class*="name"]') || c).slice(0, 40) || '',
                    bossTitle: '', companySize: '', companyType: '',
                    url: a ? a.href : ''
                });
            }
            return out;
        }""") or []
    except Exception:
        return []


def _find_chat_button(page, scope='card'):
    """定位「聊一聊」按钮：文本匹配（优先按钮/链接元素），返回可点击 Locator 或 None。"""
    try:
        hit = page.evaluate("""(pat) => {
            const all = Array.from(document.querySelectorAll('button, a, [role="button"], span, div'));
            const text = (el) => (el.textContent || '').trim().replace(/\\s+/g, ' ');
            const visible = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch(e) { return false; } };
            const re = new RegExp(pat);
            const hits = all.filter(el => visible(el) && text(el).length <= 10 && re.test(text(el)));
            if (!hits.length) return '';
            hits.sort((a, b) => text(a).length - text(b).length);
            hits[0].setAttribute('data-liepin-chat-btn', '1');
            return text(hits[0]);
        }""", r'聊\s*一\s*聊|和\s*TA\s*聊聊|与\s*TA\s*聊聊|和\s*他\s*聊聊|和\s*她\s*聊聊')
        if not hit:
            return None
        loc = page.locator('[data-liepin-chat-btn]').first
        return loc if loc.count() > 0 else None
    except Exception:
        return None


def _chat_established(page) -> bool:
    """确认已建立会话：按钮态变「继续聊」或聊天窗口/输入框出现（对齐安全不变量：未确认不计成功）。"""
    try:
        established = page.evaluate("""() => {
            const text = (el) => (el.textContent || '').trim().replace(/\\s+/g, ' ');
            const visible = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch(e) { return false; } };
            const all = Array.from(document.querySelectorAll('button, a, [role="button"], span, div'));
            const hasContinue = all.some(el => visible(el) && /^继续\\s*聊$/.test(text(el)) && text(el).length <= 8);
            const hasChatInput = !!document.querySelector('#chat-input, [contenteditable="true"], textarea');
            return hasContinue || hasChatInput;
        }""")
        return bool(established)
    except Exception:
        return False


def deliver(job: dict, greeting: str, os_name: str | None = None,
            send_resume_image: bool = False, send_online_resume: bool = False,
            expected: dict | None = None, resume_images: list | None = None,
            mode: str = 'auto', reply_text: str | None = None) -> dict:
    """猎聘投递：打开岗位 → 点「聊一聊」→ 确认聊天窗/「继续聊」态（App 预设招呼语自动发送）。
    不注入招呼语文本；greeting 仅作非空校验（管线安全不变量）。"""
    job_id = str(job.get('jobId') or job.get('id') or '').strip()
    url = str(job.get('url') or '').strip()
    if not job_id and not url:
        return {"ok": False, "code": 400, "message": "缺少岗位 jobId/url", "sent": False}
    if not str(greeting or '').strip():
        return {"ok": False, "code": 400, "message": "招呼语为空，拒绝投递", "sent": False}

    log('💬', f'[liepin] 投递 → job={job_id}（聊一聊，App 预设招呼语）')

    with open_browser(os_name=os_name, headless=False) as page:
        cookies = load_cookies(PLATFORM)
        if cookies:
            try:
                page.context.add_cookies(cookies)
            except Exception as e:
                log('⚠️', f'[liepin] 注入 Cookie 失败：{e}')

        # 登录态粗检（登录后才显示聊一聊）
        if not goto_stable(page, url or build_search_url('Python', '', '', 1), wait=2.5):
            return {"ok": False, "code": 35, "message": "猎聘页面未加载（可能被反爬拦截）", "sent": False}
        risk = risk_text_hit(page)
        if risk:
            return {"ok": False, "code": 35, "message": f"检测到安全验证/访问受限（{risk}），已暂停", "sent": False}
        if 'login' in (page.url or '').lower():
            return {"ok": False, "code": 31, "message": "未登录猎聘，请先扫码登录", "sent": False}

        if url and '/job/' in url:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            human_sleep(3.5, 0.35, 2.0)
        risk = risk_text_hit(page)
        if risk:
            return {"ok": False, "code": 35, "message": f"检测到安全验证/访问受限（{risk}），已暂停", "sent": False}

        btn = _find_chat_button(page)
        if btn is None:
            save_cookies(page.context, PLATFORM)
            return {"ok": False, "code": 404, "message": "未找到「聊一聊」按钮（岗位可能已下架或已投递）", "sent": False}

        # 点击前已「继续聊」→ 已建立会话（不重复发送）
        if CONTINUE_CHAT_RE.search(str(btn.inner_text() or '')):
            save_cookies(page.context, PLATFORM)
            return {"ok": True, "code": 0, "sent": True, "method": "liepin-continue-chat"}

        try:
            btn.click(timeout=8000)
        except Exception as e:
            save_cookies(page.context, PLATFORM)
            return {"ok": False, "code": 500, "message": f"点击「聊一聊」失败：{e}", "sent": False}

        # 确认已建立会话（聊天窗 / 按钮态「继续聊」），未确认不计成功
        confirmed = False
        deadline = time.time() + 15
        while time.time() < deadline:
            if _chat_established(page):
                confirmed = True
                break
            human_sleep(0.6, 0.4, 0.3)
        if not confirmed:
            human_sleep(2.5, 0.3, 1.5)
            confirmed = _chat_established(page)
        if not confirmed:
            save_cookies(page.context, PLATFORM)
            return {"ok": False, "code": 501, "message": "未能确认已建立沟通（未确认不计成功），请人工核对", "sent": False}

        # 关闭聊天窗口（收尾，不影响结果）
        try:
            page.evaluate("""() => {
                const all = Array.from(document.querySelectorAll('button, [role="button"], [class*="close"], [class*="dialog"] [class*="close"]'));
                const text = (el) => (el.textContent || '').trim();
                const visible = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch(e) { return false; } };
                const hit = all.find(el => visible(el) && (/^(关闭|×|X)$/.test(text(el)) || /close/i.test(el.className || '')));
                if (hit) hit.click();
            }""")
        except Exception:
            pass

        save_cookies(page.context, PLATFORM)
        return {"ok": True, "code": 0, "sent": True, "method": "liepin-chat"}


def do_login(timeout: int = 180, os_name: str | None = None) -> dict:
    """打开可见窗口扫码登录猎聘，Cookie 持久化。"""
    log('🔐', '[liepin] 打开登录窗口，请用猎聘 App 扫码')
    with open_browser(os_name=os_name, headless=False) as page:
        cookies = load_cookies(PLATFORM)
        if cookies:
            try:
                page.context.add_cookies(cookies)
            except Exception:
                pass
        if not goto_stable(page, 'https://www.liepin.com/login/', wait=3):
            return {"ok": False, "code": 35, "message": "猎聘登录页未能加载，请重试"}
        start = time.time()
        last_count = 0
        while time.time() - start < timeout:
            current = (page.url or '').strip().lower()
            if current and current.startswith('http') and 'liepin.com' in current \
                    and not LOGIN_LEAVE_RE.search(current):
                save_cookies(page.context, PLATFORM)
                return {"ok": True, "loggedIn": True}
            try:
                cookies_now = page.context.cookies()
                if len(cookies_now) != last_count:
                    last_count = len(cookies_now)
                    log('👀', f'[liepin] 等待扫码中…（cookies: {last_count}）')
            except Exception:
                pass
            time.sleep(2)
        return {"ok": False, "code": 31, "message": "猎聘扫码登录超时，请重试"}
