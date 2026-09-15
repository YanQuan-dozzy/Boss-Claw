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

本模块只保留**平台差异**（常量表 / JS 选择器 / 接口解析 / 按钮定位与确认），
搜索·投递·登录三段骨架统一由 `base.CollectorBase` 提供（对齐 BossHunter 分层）。
"""
import re

from .base import CollectorBase
from .filters import build_filter_params
from .models import JobCandidate

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


def format_jobs(raw: list, keyword: str = '', page: int = 0) -> list:
    """猎聘 jobCardList → 统一 `JobCandidate` 列表。"""
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
        out.append(JobCandidate(
            platform=PLATFORM,
            jobId=str(job_id),
            title=job.get('title') or '',
            company=comp.get('compName') or '',
            salary=job.get('salary') or '',
            location=job.get('dq') or '',
            experience=job.get('requireWorkYears') or '',
            degree=job.get('requireEduLevel') or '',
            recruiterName=recruiter.get('recruiterName') or '',
            bossTitle=recruiter.get('recruiterTitle') or '',
            companySize=comp.get('compScale') or '',
            companyType=comp.get('compIndustry') or '',
            url=link,
            sourceKeyword=str(keyword or ''),
            sourcePage=int(page or 0),
        ))
    return out


# DOM 卡片兜底提取（接口拦截失败时用）
JS_DOM_CARDS = r"""() => {
    const out = [];
    const text = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ');
    const cards = Array.from(document.querySelectorAll('li[data-tlg-ext], .job-card, [class*="job-card"], [class*="jobCard"], li'));
    const seen = new Set();
    for (const c of cards) {
        if (seen.has(c)) continue; seen.add(c);
        const t = text(c);
        if (!t || t.length < 10 || t.length > 900) continue;
        let jobId = '';
        try { const ext = c.getAttribute('data-tlg-ext') || ''; const m = ext.match(/jobId[\\":=]+(\d+)/); if (m) jobId = m[1]; } catch(e) {}
        if (!jobId) { try { const a = c.querySelector('a[href*="/job/"]'); if (a && a.href) { const m = a.href.match(/job[\\/]*(\d+)/); if (m) jobId = m[1]; } } catch(e) {} }
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
}"""

# 「聊一聊」按钮定位（标记 data-liepin-chat-btn）
JS_FIND_CHAT_BTN = r"""(pat) => {
    const all = Array.from(document.querySelectorAll('button, a, [role="button"], span, div'));
    const text = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ');
    const visible = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch(e) { return false; } };
    const re = new RegExp(pat);
    const hits = all.filter(el => visible(el) && text(el).length <= 10 && re.test(text(el)));
    if (!hits.length) return '';
    hits.sort((a, b) => text(a).length - text(b).length);
    hits[0].setAttribute('data-liepin-chat-btn', '1');
    return text(hits[0]);
}"""

# 已建立会话确认：按钮态「继续聊」或聊天窗/输入框出现
JS_CHAT_ESTABLISHED = r"""() => {
    const text = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ');
    const visible = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch(e) { return false; } };
    const all = Array.from(document.querySelectorAll('button, a, [role="button"], span, div'));
    const hasContinue = all.some(el => visible(el) && /^继续\s*聊$/.test(text(el)) && text(el).length <= 8);
    const hasChatInput = !!document.querySelector('#chat-input, [contenteditable="true"], textarea');
    return hasContinue || hasChatInput;
}"""

# 投递成功后的收尾：关闭聊天窗口
JS_CLOSE_CHAT = r"""() => {
    const all = Array.from(document.querySelectorAll('button, [role="button"], [class*="close"], [class*="dialog"] [class*="close"]'));
    const text = (el) => (el.textContent || '').trim();
    const visible = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch(e) { return false; } };
    const hit = all.find(el => visible(el) && (/^(关闭|×|X)$/.test(text(el)) || /close/i.test(el.className || '')));
    if (hit) hit.click();
}"""


class LiepinCollector(CollectorBase):
    platform = PLATFORM
    label = '猎聘'
    home_url = 'https://www.liepin.com'
    login_url = 'https://www.liepin.com/login/'
    login_host = 'liepin.com'
    api_hint = SEARCH_API_HINT
    # 详情页 URL 特征（投递时需再导航一次）
    detail_markers = ('/job/',)
    # 接口数据等待轮询次数（实测 6 次足够；对齐改造前取值）
    capture_wait_attempts = 6
    # 「继续聊」= 已建立会话（点击前短路，不重复发送）
    supports_already_sent = True
    # 确认最长等待 15s + 收尾停顿 2.5s（对齐改造前取值）
    confirm_timeout_seconds = 15.0
    confirm_settle_seconds = 2.5

    # ---------- 采集差异 ----------
    def build_search_url(self, query, city, salary, page=1, criteria=None) -> str:
        return build_search_url(query, city, salary, page, criteria)

    def parse_api_payload(self, root: dict) -> list:
        """pc-search-job → jobCardList（兼容 data.data 与 data 两层包裹）。"""
        data = (root or {}).get('data') or {}
        inner = data.get('data') if isinstance(data, dict) else None
        cards = inner.get('jobCardList') if isinstance(inner, dict) else None
        if not cards:
            cards = data.get('jobCardList') if isinstance(data, dict) else None
        return cards if isinstance(cards, list) else []

    def format_jobs(self, raw, keyword='', page=0) -> list:
        return format_jobs(raw, keyword, page)

    def dom_cards_js(self) -> str:
        return JS_DOM_CARDS

    # ---------- 投递差异 ----------
    def find_action_button(self, page):
        """定位「聊一聊」：已「继续聊」→ ('already', loc)，否则 ('ready', loc) / ('not_found', None)。"""
        try:
            hit = page.evaluate(
                JS_FIND_CHAT_BTN,
                r'聊\s*一\s*聊|和\s*TA\s*聊聊|与\s*TA\s*聊聊|和\s*他\s*聊聊|和\s*她\s*聊聊',
            )
            if not hit:
                return 'not_found', None
            loc = page.locator('[data-liepin-chat-btn]').first
            if loc.count() <= 0:
                return 'not_found', None
            if CONTINUE_CHAT_RE.search(str(loc.inner_text() or '')):
                return 'already', loc
            return 'ready', loc
        except Exception:
            return 'not_found', None

    def confirm_sent(self, page) -> bool:
        try:
            return bool(page.evaluate(JS_CHAT_ESTABLISHED))
        except Exception:
            return False

    def action_label(self) -> str:
        return '聊一聊'

    def missing_button_message(self) -> str:
        return '未找到「聊一聊」按钮（岗位可能已下架或已投递）'

    def already_sent_method(self) -> str:
        return 'liepin-continue-chat'

    def success_method(self) -> str:
        return 'liepin-chat'

    def after_sent(self, page) -> None:
        """收尾：关闭聊天窗口（不影响结果）。"""
        try:
            page.evaluate(JS_CLOSE_CHAT)
        except Exception:
            pass


# ============================================================
# 模块级薄壳（保持 server 调用签名不变）
# ============================================================
_COLLECTOR = LiepinCollector()


def search_jobs(query: str, city: str, pages: int = 1, os_name: str | None = None,
                criteria: dict | None = None, force: bool = False,
                config: dict | None = None) -> dict:
    """猎聘隐身搜索：搜索页 + 拦截 pc-search-job 接口 JSON + DOM 卡片兜底。"""
    return _COLLECTOR.search_jobs(query, city, pages, os_name, criteria, force, config)


def deliver(job: dict, greeting: str, os_name: str | None = None,
            send_resume_image: bool = False, send_online_resume: bool = False,
            expected: dict | None = None, resume_images: list | None = None,
            mode: str = 'auto', reply_text: str | None = None) -> dict:
    """猎聘投递：点「聊一聊」→ 确认聊天窗/「继续聊」态（App 预设招呼语自动发送）。"""
    return _COLLECTOR.deliver(job, greeting, os_name, send_resume_image, send_online_resume,
                              expected, resume_images, mode, reply_text)


def do_login(timeout: int = 180, os_name: str | None = None) -> dict:
    """打开可见窗口扫码登录猎聘，Cookie 持久化。"""
    return _COLLECTOR.do_login(timeout, os_name)
