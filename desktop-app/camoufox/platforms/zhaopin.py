#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
智联招聘（Zhaopin）平台模块 —— 搜索 / 投递 / 扫码登录
================================================
口径来源：get_jobs(loks666) ZhiLian.java + 公开爬虫口径
  - 搜索 URL（新版路径式）：https://www.zhaopin.com/sou/jl{city}/p{page}?sl={salary}
    关键词在页内搜索框输入（input[placeholder*='职位'] / input[name='kw']）
  - 数据源：fe-api.zhaopin.com/c/i/sou（GET，cityId/kw/start 参数，pageSize=60）
  - 投递：点「立即投递」→ 确认「投递成功」弹层/toast 或按钮态「已投递」→ 计成功
  - 平台侧每日约 100 次投递上限：命中上限提示立即停止交人工
  - 安全：风控/上限命中即停，不绕过验证码
"""
import re
import time
import json

from .common import (
    log, human_sleep, human_delay, open_browser, load_cookies, save_cookies,
    goto_stable, risk_text_hit, DAILY_LIMIT_RE,
)

PLATFORM = 'zhaopin'

# jl 城市码（公开爬虫口径；未知城市省略 = 全国）
CITY_CODES = {
    '全国': '', '北京': '530', '上海': '489', '深圳': '765', '天津': '532',
    '重庆': '481', '广州': '763', '杭州': '653', '成都': '801', '武汉': '736',
    '南京': '635', '苏州': '639', '西安': '854', '郑州': '713', '长沙': '749',
    '青岛': '857', '厦门': '683', '沈阳': '483', '大连': '682', '济南': '636',
}
# sl 薪资码（智联：2K以下=1 … 50K以上=7）
SALARY_CODES = {
    '2K以下': '1', '2-5K': '2', '5-10K': '3', '10-15K': '4',
    '15-25K': '5', '25-50K': '6', '50K以上': '7',
}
SEARCH_API_HINT = 'fe-api.zhaopin.com/c/i/sou'

# 投递按钮文本（投递/立即投递）
DELIVER_BTN_RE = re.compile(r'立\s*即\s*投递|投\s*递\s*简\s*历|投\s*递')
# 已投递按钮态
DELIVERED_RE = re.compile(r'已\s*投递|投递成功|投递完成')
# 投递成功弹层/toast
DELIVER_OK_RE = re.compile(r'投递成功|投递完成|已投递')
# 外部网申（第三方跳转，跳过）
EXTERNAL_RE = re.compile(r'立即\s*网申|去\s*网申|前往\s*申请|查看详情并投递|前往企业官网')
LOGIN_LEAVE_RE = re.compile(r'/login|passport|security|verify', re.I)


def _resolve_city(city: str) -> str:
    c = str(city or '').strip()
    if not c or c in ('不限', '全部', '全国'):
        return ''
    if c in CITY_CODES:
        return CITY_CODES[c]
    for name, code in CITY_CODES.items():
        if code and (name.startswith(c) or c.startswith(name)):
            return code
    return ''


def _resolve_salary(salary: str) -> str:
    s = str(salary or '').strip()
    if not s or s in ('不限', '全部'):
        return ''
    if re.fullmatch(r'\d{1,2}', s):
        return s
    return SALARY_CODES.get(s, '')


def build_search_url(query: str, city: str, salary: str, page: int = 1) -> str:
    code = _resolve_city(city)
    sal = _resolve_salary(salary)
    url = f"https://www.zhaopin.com/sou/{f'jl{code}' if code else ''}/p{max(1, page)}"
    if sal:
        url += f"?sl={sal}"
    q = str(query or '').strip()
    if q:
        url += f"{'&' if sal else '?'}kw={q}"
    return url


def format_jobs(raw: list) -> list:
    """智联 fe-api results → Boss-claw JobMeta 兼容结构。"""
    out = []
    for j in raw:
        jid = j.get('number') or j.get('jobId') or ''
        if not jid:
            continue
        pos_url = j.get('positionURL') or j.get('positionUrl') or ''
        out.append({
            "platform": PLATFORM,
            "jobId": str(jid),
            "title": j.get('jobName') or '',
            "company": j.get('company') or j.get('companyName') or '',
            "salary": j.get('salary') or '',
            "location": j.get('city') or j.get('cityName') or '',
            "experience": j.get('workingExp') or '',
            "degree": j.get('eduLevel') or '',
            "labels": j.get('welfare') if isinstance(j.get('welfare'), list) else [],
            "skills": [],
            "description": '',
            "recruiterName": j.get('hrName') or '',
            "bossTitle": j.get('hrTitle') or '',
            "companySize": j.get('companySize') or j.get('companySizeName') or '',
            "companyType": j.get('companyType') or '',
            "url": pos_url,
        })
    return out


def search_jobs(query: str, city: str, pages: int = 1, os_name: str | None = None) -> dict:
    """智联隐身搜索：访问搜索页（页内输入关键词）+ 拦截 fe-api 响应 + DOM 兜底。"""
    log('🔍', f'[zhaopin] 搜索：{query} / city={city} / pages={pages}')
    all_jobs = []
    last_code = 0
    last_msg = ''
    captured = []

    with open_browser(os_name=os_name) as page:
        cookies = load_cookies(PLATFORM)
        if cookies:
            try:
                page.context.add_cookies(cookies)
            except Exception as e:
                log('⚠️', f'[zhaopin] 注入 Cookie 失败：{e}')

        def on_response(response):
            try:
                if response.status != 200:
                    return
                u = response.url or ''
                if SEARCH_API_HINT in u:
                    ctype = (response.headers.get('content-type') or '')
                    if 'json' not in ctype and ctype:
                        return
                    text = response.text()
                    if text:
                        root = json.loads(text)
                        results = ((root.get('data') or {}).get('results') or [])
                        if isinstance(results, list) and results:
                            captured.extend(results)
            except Exception:
                pass

        page.on("response", on_response)

        for page_num in range(1, pages + 1):
            url = build_search_url(query, city, '', page_num)
            log('📄', f'[zhaopin] Page {page_num}: {url}')
            if not goto_stable(page, url, wait=2.5):
                last_code, last_msg = 37, 'zhaopin 页面加载失败'
                break
            risk = risk_text_hit(page)
            if risk:
                last_code, last_msg = 35, f'风控：{risk}'
                break
            # 页内搜索框输入关键词（路径式 URL 不带 kw）
            if page_num == 1:
                _type_keyword(page, query)
            for _ in range(8):
                if captured:
                    break
                time.sleep(1.5)
            dom_jobs = _collect_dom_cards(page)
            all_jobs.extend(format_jobs(captured) if captured else [])
            if dom_jobs and not captured:
                all_jobs.extend(dom_jobs)
            captured = []
            log('✅', f'[zhaopin] Page {page_num}: {len(all_jobs)} 个岗位')
            if page_num < pages:
                human_sleep(3 + (page_num % 3), 0.4, 1.5)

    if last_code in (35, 36, 32, 37):
        return {"ok": False, "code": last_code, "message": last_msg, "jobs": []}
    return {"ok": True, "code": 0, "jobs": all_jobs}


def _type_keyword(page, query: str):
    """页内搜索框输入关键词并回车（对齐 get_jobs ZhiLian.java findKeywordInput）。"""
    q = str(query or '').strip()
    if not q:
        return
    try:
        ok = page.evaluate("""(kw) => {
            const sels = ["input[placeholder*='职位']", "input[placeholder*='公司']",
                          "input[name='kw']", "input[type='text']",
                          "input[class*='search'], input[class*='sou'], input[class*='input']"];
            for (const sel of sels) {
                const el = document.querySelector(sel);
                if (el && el.offsetWidth > 0 && !el.disabled) {
                    el.focus();
                    el.value = '';
                    el.value = kw;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                }
            }
            return false;
        }""", q)
        if ok:
            page.keyboard.press('Enter')
            human_sleep(2.2, 0.3, 1.2)
    except Exception as e:
        log('⚠️', f'[zhaopin] 搜索框输入失败：{e}')


def _collect_dom_cards(page) -> list:
    """DOM 卡片兜底提取（接口拦截失败时用）。"""
    try:
        return page.evaluate("""() => {
            const out = [];
            const text = (el) => (el.textContent || '').trim().replace(/\\s+/g, ' ');
            const cards = Array.from(document.querySelectorAll('[class*="joblist-box"] a, [class*="joblist"] a, [class*="job-card"], a[href*="/jobdetail/"]'));
            const seen = new Set();
            for (const c of cards) {
                const a = c.matches('a') ? c : c.querySelector('a');
                const href = a ? a.href : '';
                if (!href || seen.has(href)) continue; seen.add(href);
                const m = href.match(/jobdetail\\/([^/?]+)/i);
                if (!m) continue;
                out.push({
                    platform: 'zhaopin',
                    jobId: m[1],
                    title: text(c).slice(0, 120) || '岗位',
                    company: '', salary: '', location: '', experience: '', degree: '',
                    labels: [], skills: [], description: '',
                    recruiterName: '', bossTitle: '', companySize: '', companyType: '',
                    url: href
                });
            }
            return out;
        }""") or []
    except Exception:
        return []


def _find_deliver_button(page):
    """定位「投递 / 立即投递」按钮（排除外部网申/已投递态）。"""
    try:
        state = page.evaluate("""() => {
            const all = Array.from(document.querySelectorAll('button, a, [role="button"], span, div'));
            const text = (el) => (el.textContent || '').trim().replace(/\\s+/g, ' ');
            const visible = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch(e) { return false; } };
            const hits = all.filter(el => visible(el) && text(el).length <= 10 && /投递/.test(text(el)));
            if (!hits.length) return 'not_found';
            hits.sort((a, b) => text(b).length - text(a).length);
            const label = text(hits[0]);
            const el = hits[0];
            if (/已\\s*投递/.test(label)) return 'delivered';
            if (/网申|前往申请|企业官网/.test(label)) return 'external';
            el.setAttribute('data-zhaopin-deliver', '1');
            return 'ready';
        }""")
        if state == 'ready':
            loc = page.locator('[data-zhaopin-deliver]').first
            return 'ready', loc if loc.count() > 0 else None
        return state, None
    except Exception:
        return 'not_found', None


def _deliver_confirmed(page) -> bool:
    """确认投递成功：弹层/toast 含「投递成功/投递完成」或按钮态「已投递」。"""
    try:
        return bool(page.evaluate("""() => {
            const text = (el) => (el.textContent || '').trim().replace(/\\s+/g, ' ');
            const visible = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch(e) { return false; } };
            const body = (document.body ? document.body.innerText : '') || '';
            if (/投递成功|投递完成/.test(body.slice(0, 4000))) return true;
            const all = Array.from(document.querySelectorAll('button, a, [role="button"], span, div'));
            return all.some(el => visible(el) && /^已\\s*投递$/.test(text(el)) && text(el).length <= 8);
        }"""))
    except Exception:
        return False


def deliver(job: dict, greeting: str, os_name: str | None = None,
            send_resume_image: bool = False, send_online_resume: bool = False,
            expected: dict | None = None, resume_images: list | None = None,
            mode: str = 'auto', reply_text: str | None = None) -> dict:
    """智联投递：打开岗位详情 → 点「投递」→ 确认投递成功（未确认不计成功）。
    平台每日约 100 次上限：命中即停交人工。"""
    job_id = str(job.get('jobId') or job.get('id') or '').strip()
    url = str(job.get('url') or '').strip()
    if not job_id and not url:
        return {"ok": False, "code": 400, "message": "缺少岗位 jobId/url", "sent": False}
    if not str(greeting or '').strip():
        return {"ok": False, "code": 400, "message": "招呼语为空，拒绝投递", "sent": False}

    log('💬', f'[zhaopin] 投递 → job={job_id}（投递简历）')

    with open_browser(os_name=os_name, headless=False) as page:
        cookies = load_cookies(PLATFORM)
        if cookies:
            try:
                page.context.add_cookies(cookies)
            except Exception as e:
                log('⚠️', f'[zhaopin] 注入 Cookie 失败：{e}')

        target = url or build_search_url('Python', '', '', 1)
        if not goto_stable(page, target, wait=2.5):
            return {"ok": False, "code": 35, "message": "智联页面未加载（可能被反爬拦截）", "sent": False}
        risk = risk_text_hit(page)
        if risk:
            return {"ok": False, "code": 35, "message": f"检测到安全验证/访问受限（{risk}），已暂停", "sent": False}
        if 'login' in (page.url or '').lower() or 'passport' in (page.url or '').lower():
            return {"ok": False, "code": 31, "message": "未登录智联招聘，请先扫码登录", "sent": False}

        if url and '/jobdetail' in url:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            human_sleep(3.5, 0.35, 2.0)
        risk = risk_text_hit(page)
        if risk:
            return {"ok": False, "code": 35, "message": f"检测到安全验证/访问受限（{risk}），已暂停", "sent": False}

        state, btn = _find_deliver_button(page)
        if state == 'delivered':
            save_cookies(page.context, PLATFORM)
            return {"ok": True, "code": 0, "sent": True, "method": "zhaopin-already"}
        if state == 'external':
            save_cookies(page.context, PLATFORM)
            return {"ok": False, "code": 600, "external": True, "message": "该岗位为外部网申，无法自动投递，跳过", "sent": False}
        if btn is None:
            save_cookies(page.context, PLATFORM)
            return {"ok": False, "code": 404, "message": "未找到「投递」按钮（岗位可能已下架）", "sent": False}

        try:
            btn.click(timeout=8000)
        except Exception as e:
            save_cookies(page.context, PLATFORM)
            return {"ok": False, "code": 500, "message": f"点击「投递」失败：{e}", "sent": False}

        # 每日上限检测
        human_sleep(2.0, 0.4, 1.0)
        daily = False
        try:
            body = page.evaluate("() => (document.body ? document.body.innerText.slice(0, 4000) : '')") or ''
            daily = bool(DAILY_LIMIT_RE.search(body))
        except Exception:
            pass
        if daily:
            save_cookies(page.context, PLATFORM)
            return {"ok": False, "code": 32, "message": "智联招聘今日投递已达上限，已停止，请明日再试或人工处理", "sent": False}

        confirmed = False
        deadline = time.time() + 12
        while time.time() < deadline:
            if _deliver_confirmed(page):
                confirmed = True
                break
            human_sleep(0.5, 0.4, 0.3)
        if not confirmed:
            human_sleep(2.0, 0.3, 1.2)
            confirmed = _deliver_confirmed(page)
        if not confirmed:
            save_cookies(page.context, PLATFORM)
            return {"ok": False, "code": 501, "message": "未能确认投递成功（未确认不计成功），请人工核对", "sent": False}

        save_cookies(page.context, PLATFORM)
        return {"ok": True, "code": 0, "sent": True, "method": "zhaopin-deliver"}


def do_login(timeout: int = 180, os_name: str | None = None) -> dict:
    """打开可见窗口扫码登录智联招聘，Cookie 持久化。"""
    log('🔐', '[zhaopin] 打开登录窗口，请用智联招聘 App 扫码')
    with open_browser(os_name=os_name, headless=False) as page:
        cookies = load_cookies(PLATFORM)
        if cookies:
            try:
                page.context.add_cookies(cookies)
            except Exception:
                pass
        if not goto_stable(page, 'https://passport.zhaopin.com/login', wait=3):
            return {"ok": False, "code": 35, "message": "智联登录页未能加载，请重试"}
        start = time.time()
        last_count = 0
        while time.time() - start < timeout:
            current = (page.url or '').strip().lower()
            if current and current.startswith('http') and 'zhaopin.com' in current \
                    and not LOGIN_LEAVE_RE.search(current):
                save_cookies(page.context, PLATFORM)
                return {"ok": True, "loggedIn": True}
            try:
                cookies_now = page.context.cookies()
                if len(cookies_now) != last_count:
                    last_count = len(cookies_now)
                    log('👀', f'[zhaopin] 等待扫码中…（cookies: {last_count}）')
            except Exception:
                pass
            time.sleep(2)
        return {"ok": False, "code": 31, "message": "智联扫码登录超时，请重试"}
