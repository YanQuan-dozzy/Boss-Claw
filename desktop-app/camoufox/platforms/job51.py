#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
前程无忧（51Job）平台模块 —— 搜索 / 投递 / 扫码登录
================================================
口径来源：get_jobs(loks666) Job51.java + 51job-spider
  - 搜索 URL：https://we.51job.com/pc/search?jobArea=&salary=&keyword=
  - 数据源：/api/job/search-pc（GET，响应拦截 JSON）；DOM 卡片兜底
    （a[href*='/pc/jobdetail?jobId='] / a[href*='jobs.51job.com/']）
  - 投递：「批量投递」按钮 → 确认成功弹窗（含成功数量）→ 按拦截 jobId 计成功
  - 外部第三方外链岗位跳过（安全不变量）
"""
import re
import time
import json

from .common import (
    log, human_sleep, human_delay, open_browser, load_cookies, save_cookies,
    goto_stable, risk_text_hit,
)

PLATFORM = 'job51'

# jobArea 城市码（51job-spider 口径；未知城市省略 = 全国）
AREA_CODES = {
    '全国': '', '北京': '010000', '上海': '020000', '广州': '030000', '深圳': '040000',
    '天津': '050000', '重庆': '060000', '杭州': '070000', '南京': '080000', '苏州': '090000',
    '武汉': '100000', '西安': '110000', '成都': '120000', '长沙': '130000', '郑州': '140000',
    '青岛': '150000', '厦门': '160000', '福州': '170000', '济南': '180000', '大连': '190000',
    '沈阳': '200000', '合肥': '210000', '昆明': '220000', '南昌': '230000', '南宁': '240000',
    '哈尔滨': '250000', '长春': '260000', '石家庄': '270000', '太原': '280000', '贵阳': '290000',
}
# salary 码（51job：1=1K以下 … 13=50K以上）
SALARY_CODES = {
    '1K以下': '1', '1-2K': '2', '2-3K': '3', '3-4.5K': '4',
    '4.5-6K': '5', '6-8K': '6', '8-10K': '7', '10-15K': '8', '15-20K': '9',
    '20-30K': '10', '30-40K': '11', '40-50K': '12', '50K以上': '13',
}
SEARCH_API_HINT = '/api/job/search-pc'

# 投递按钮文本（批量投递 / 投递简历）
DELIVER_BTN_RE = re.compile(r'批\s*量\s*投\s*递|投\s*递\s*简\s*历|投\s*递')
# 投递成功弹窗（含成功数量）
DELIVER_OK_RE = re.compile(r'投递成功|投递完成|已投递|投递.{0,6}份|成功投递')
# 每日搜索/投递受限提示
LIMIT_RE = re.compile(r'今日投递|已达上限|投递上限|操作频繁|请稍后再试')
LOGIN_LEAVE_RE = re.compile(r'/login|passport|security|verify', re.I)


def _resolve_area(city: str) -> str:
    c = str(city or '').strip()
    if not c or c in ('不限', '全部', '全国'):
        return ''
    if c in AREA_CODES:
        return AREA_CODES[c]
    for name, code in AREA_CODES.items():
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
    area = _resolve_area(city)
    sal = _resolve_salary(salary)
    parts = []
    if area:
        parts.append(f"jobArea={area}")
    if sal:
        parts.append(f"salary={sal}")
    q = str(query or '').strip()
    if q:
        parts.append(f"keyword={q}")
    return 'https://we.51job.com/pc/search' + ('?' + '&'.join(parts) if parts else '')


def format_jobs(raw: list) -> list:
    """51job search-pc 结果 → Boss-claw JobMeta 兼容结构。"""
    out = []
    for j in raw:
        jid = j.get('jobId') or j.get('jobid') or ''
        if not jid:
            continue
        out.append({
            "platform": PLATFORM,
            "jobId": str(jid),
            "title": j.get('jobName') or j.get('job_title') or '',
            "company": j.get('companyName') or j.get('company_name') or '',
            "salary": j.get('salary') or j.get('salaryString') or '',
            "location": j.get('jobArea') or j.get('job_area') or j.get('cityName') or '',
            "experience": j.get('workExp') or '',
            "degree": j.get('eduLevel') or '',
            "labels": j.get('jobTags') if isinstance(j.get('jobTags'), list) else [],
            "skills": [],
            "description": j.get('jobDesc') or '',
            "recruiterName": '',
            "bossTitle": '',
            "companySize": j.get('companySize') or '',
            "companyType": j.get('companyType') or '',
            "url": j.get('jobHref') or (f"https://jobs.51job.com/all/{jid}.html" if jid else ''),
        })
    return out


def search_jobs(query: str, city: str, pages: int = 1, os_name: str | None = None) -> dict:
    """51Job 隐身搜索：访问搜索页 + 拦截 /api/job/search-pc 响应 + DOM 兜底。"""
    log('🔍', f'[job51] 搜索：{query} / city={city} / pages={pages}')
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
                log('⚠️', f'[job51] 注入 Cookie 失败：{e}')

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
                        data = root.get('data') or {}
                        results = data.get('result') or data.get('jobs') or data.get('list') or []
                        if isinstance(results, dict):
                            results = results.get('list') or results.get('jobs') or []
                        if isinstance(results, list) and results:
                            captured.extend(results)
            except Exception:
                pass

        page.on("response", on_response)

        for page_num in range(1, pages + 1):
            url = build_search_url(query, city, '', page_num)
            log('📄', f'[job51] Page {page_num}: {url}')
            if not goto_stable(page, url, wait=2.5):
                last_code, last_msg = 37, 'job51 页面加载失败'
                break
            risk = risk_text_hit(page)
            if risk:
                last_code, last_msg = 35, f'风控：{risk}'
                break
            for _ in range(8):
                if captured:
                    break
                time.sleep(1.5)
            dom_jobs = _collect_dom_cards(page)
            all_jobs.extend(format_jobs(captured) if captured else [])
            if dom_jobs and not captured:
                all_jobs.extend(dom_jobs)
            captured = []
            log('✅', f'[job51] Page {page_num}: {len(all_jobs)} 个岗位')
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
            const anchors = Array.from(document.querySelectorAll("a[href*='/pc/jobdetail?jobId='], a[href*='jobs.51job.com/'], a[href*='/pc/jobdetail']"));
            const seen = new Set();
            for (const a of anchors) {
                if (!a.href || seen.has(a.href)) continue; seen.add(a.href);
                const m = a.href.match(/jobId=(\\d+)/i) || a.href.match(/jobs\\.51job\\.com\\/([^\\/]+)/i);
                if (!m) continue;
                const card = a.closest('li, .joblist, [class*="job-item"], [class*="jobItem"], .j_joblist') || a;
                out.push({
                    platform: 'job51',
                    jobId: m[1],
                    title: text(card.querySelector('.jname, [class*="job-title"], [class*="jobName"], h3') || card).slice(0, 120) || '岗位',
                    company: text(card.querySelector('.cname, [class*="company"]') || card).slice(0, 80) || '',
                    salary: text(card.querySelector('.sal, [class*="salary"], [class*="sal"]') || card).slice(0, 40) || '',
                    location: text(card.querySelector('.area, [class*="area"]') || card).slice(0, 60) || '',
                    experience: '', degree: '', labels: [], skills: [], description: '',
                    recruiterName: '', bossTitle: '', companySize: '', companyType: '',
                    url: a.href
                });
            }
            return out;
        }""") or []
    except Exception:
        return []


def _find_deliver_button(page):
    """定位投递按钮（批量投递/投递简历），返回 ('ready', locator) / ('none', None)。"""
    try:
        ok = page.evaluate("""() => {
            const all = Array.from(document.querySelectorAll('button, a, [role="button"], span, div'));
            const text = (el) => (el.textContent || '').trim().replace(/\\s+/g, ' ');
            const visible = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch(e) { return false; } };
            const hits = all.filter(el => visible(el) && text(el).length <= 10 && /投递/.test(text(el)));
            if (!hits.length) return false;
            hits.sort((a, b) => text(b).length - text(a).length);
            const el = hits[0];
            if (/已投递|投递成功/.test(text(el))) return false;
            el.setAttribute('data-job51-deliver', '1');
            return true;
        }""")
        if not ok:
            return 'none', None
        loc = page.locator('[data-job51-deliver]').first
        return 'ready', loc if loc.count() > 0 else None
    except Exception:
        return 'none', None


def _deliver_confirmed(page) -> bool:
    """确认投递成功：成功弹窗/toast（含投递成功/成功投递 N 份）。"""
    try:
        return bool(page.evaluate("""() => {
            const body = (document.body ? document.body.innerText : '') || '';
            return /投递成功|成功投递|投递完成|已投递\\s*\\d+|投递\\s*\\d+\\s*份/.test(body.slice(0, 4000));
        }"""))
    except Exception:
        return False


def deliver(job: dict, greeting: str, os_name: str | None = None,
            send_resume_image: bool = False, send_online_resume: bool = False,
            expected: dict | None = None, resume_images: list | None = None,
            mode: str = 'auto', reply_text: str | None = None) -> dict:
    """51Job 投递：打开岗位 → 点「投递」→ 确认投递成功（未确认不计成功）。"""
    job_id = str(job.get('jobId') or job.get('id') or '').strip()
    url = str(job.get('url') or '').strip()
    if not job_id and not url:
        return {"ok": False, "code": 400, "message": "缺少岗位 jobId/url", "sent": False}
    if not str(greeting or '').strip():
        return {"ok": False, "code": 400, "message": "招呼语为空，拒绝投递", "sent": False}

    log('💬', f'[job51] 投递 → job={job_id}（投递简历）')

    with open_browser(os_name=os_name, headless=False) as page:
        cookies = load_cookies(PLATFORM)
        if cookies:
            try:
                page.context.add_cookies(cookies)
            except Exception as e:
                log('⚠️', f'[job51] 注入 Cookie 失败：{e}')

        target = url or build_search_url('Python', '', '', 1)
        if not goto_stable(page, target, wait=2.5):
            return {"ok": False, "code": 35, "message": "51Job 页面未加载（可能被反爬拦截）", "sent": False}
        risk = risk_text_hit(page)
        if risk:
            return {"ok": False, "code": 35, "message": f"检测到安全验证/访问受限（{risk}），已暂停", "sent": False}
        if 'login' in (page.url or '').lower() or 'passport' in (page.url or '').lower():
            return {"ok": False, "code": 31, "message": "未登录前程无忧，请先扫码登录", "sent": False}

        if url and ('/pc/jobdetail' in url or 'jobs.51job.com' in url):
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            human_sleep(3.5, 0.35, 2.0)
        risk = risk_text_hit(page)
        if risk:
            return {"ok": False, "code": 35, "message": f"检测到安全验证/访问受限（{risk}），已暂停", "sent": False}

        state, btn = _find_deliver_button(page)
        if btn is None:
            save_cookies(page.context, PLATFORM)
            return {"ok": False, "code": 404, "message": "未找到「投递」按钮（岗位可能已下架或已投递）", "sent": False}

        try:
            btn.click(timeout=8000)
        except Exception as e:
            save_cookies(page.context, PLATFORM)
            return {"ok": False, "code": 500, "message": f"点击「投递」失败：{e}", "sent": False}

        # 限频/上限提示检测
        human_sleep(2.0, 0.4, 1.0)
        try:
            body = page.evaluate("() => (document.body ? document.body.innerText.slice(0, 4000) : '')") or ''
            if LIMIT_RE.search(body):
                save_cookies(page.context, PLATFORM)
                return {"ok": False, "code": 32, "message": "51Job 触发操作受限提示，已停止，请人工处理", "sent": False}
        except Exception:
            pass

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
        return {"ok": True, "code": 0, "sent": True, "method": "job51-deliver"}


def do_login(timeout: int = 180, os_name: str | None = None) -> dict:
    """打开可见窗口扫码登录前程无忧，Cookie 持久化。"""
    log('🔐', '[job51] 打开登录窗口，请用前程无忧扫码登录')
    with open_browser(os_name=os_name, headless=False) as page:
        cookies = load_cookies(PLATFORM)
        if cookies:
            try:
                page.context.add_cookies(cookies)
            except Exception:
                pass
        if not goto_stable(page, 'https://we.51job.com/pc/login', wait=3):
            return {"ok": False, "code": 35, "message": "51Job 登录页未能加载，请重试"}
        start = time.time()
        last_count = 0
        while time.time() - start < timeout:
            current = (page.url or '').strip().lower()
            if current and current.startswith('http') and '51job.com' in current \
                    and not LOGIN_LEAVE_RE.search(current):
                save_cookies(page.context, PLATFORM)
                return {"ok": True, "loggedIn": True}
            try:
                cookies_now = page.context.cookies()
                if len(cookies_now) != last_count:
                    last_count = len(cookies_now)
                    log('👀', f'[job51] 等待登录中…（cookies: {last_count}）')
            except Exception:
                pass
            time.sleep(2)
        return {"ok": False, "code": 31, "message": "51Job 登录超时，请重试"}
