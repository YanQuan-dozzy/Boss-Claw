#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
猎聘（Liepin）平台模块 —— 搜索 / 投递 / 扫码登录
============================================
口径来源：get_jobs(loks666) Liepin.java + Auto-JobHunter(jolie-z) liepin_crawler.py
  - 搜索 URL：https://www.liepin.com/zhaopin/?city=&dq=&salaryCode=&currentPage=0&key=
    （薪资参数名以平台自生成链接为准：`salaryCode`，非 `salary`）
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
# 薪资码（年薪档；2026-10-01 用户实测 10万以下=1 / 10-15万=2，其余按平台面板顺序推得）
SALARY_CODES = {
    '10万以下': '1', '10-15万': '2', '16-20万': '3', '21-30万': '4',
    '31-50万': '5', '51-100万': '6', '100万以上': '7',
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


def _fmt_num(n: float) -> str:
    """数字 → URL 文本（整数去掉小数尾巴，否则保留 1 位）。"""
    return str(int(n)) if abs(n - int(n)) < 1e-9 else f'{n:.1f}'


def _resolve_salary(salary: str) -> str:
    """薪资期望 → 猎聘 `salaryCode`。

    设置页「薪资期望」是**月薪**自由文本（如 15-25K），猎聘只认**年薪档 / 年薪自定义区间**；
    规则与 `src/lib/bossclaw/platformUrls.ts::resolveLiepinSalaryCode` **双源同步**（改动必须两边一致）：
      1) 纯数字（1-2 位）→ 平台档位码透传（10万以下=1 … 100万以上=7）
      2) 年薪档名（如 16-20万）→ 对应档位码
      3) 年薪自定义区间（万元单位，如 9-11万）→ `9$11`（平台「自定义」写法）
      4) 月薪区间（K 为单位，如 15-25K）→ 换算年薪（×12 月 ÷ 10）后走自定义区间 → `18$30`
      5) 其余（单值 20K、不限、无单位区间）→ 不附加（单值无法构成区间，宁可多召回不误杀）
    """
    s = str(salary or '').strip()
    if not s or s in ('不限', '全部', '全国'):
        return ''
    if re.fullmatch(r'\d{1,2}', s):
        return s
    if s in SALARY_CODES:
        return SALARY_CODES[s]
    m = re.fullmatch(r'(\d+(?:\.\d+)?)\s*[-~～至]\s*(\d+(?:\.\d+)?)\s*([万wWkK]?)', s)
    if not m:
        return ''
    lo, hi, unit = float(m.group(1)), float(m.group(2)), (m.group(3) or '').lower()
    if hi < lo:
        lo, hi = hi, lo
    if unit in ('万', 'w'):
        return f'{_fmt_num(lo)}${_fmt_num(hi)}'
    if unit == 'k':
        return f'{_fmt_num(lo * 1.2)}${_fmt_num(hi * 1.2)}'
    return ''


def build_search_url(query: str, city: str, salary: str, page: int = 1,
                     criteria: dict | None = None) -> str:
    """猎聘搜索 URL：城市 / 薪资 / 关键词 + 「基础求职条件」映射的经验·学历·规模·性质·活跃度。

    criteria 为设置页「基础求职条件」（全平台共用）+ HR 活跃度过滤，经
    filters.build_filter_params 翻译成本平台参数（workYearCode / eduLevel / compScale /
    compKind / compStage / pubTime；jobKind 无此筛选不附加）。
    参数名以平台自生成链接为准：**薪资是 `salaryCode`**（不是 `salary`）。
    """
    code = _resolve_city(city)
    sal = _resolve_salary(salary or ((criteria or {}).get('salary') or ''))
    url = (f"https://www.liepin.com/zhaopin/?city={code}&dq={code}"
           f"&currentPage={max(0, page - 1)}")
    if sal:
        url += f"&salaryCode={sal}"
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
            # 猎聘接口**没有**「公司性质」字段：compIndustry 是行业 → 写入 industry；
            # 不得再塞进 companyType（语义错位会让「公司性质」显示成行业）
            companyType='',
            industry=comp.get('compIndustry') or '',
            url=link,
            sourceKeyword=str(keyword or ''),
            sourcePage=int(page or 0),
        ))
    return out


# DOM 卡片兜底提取（接口拦截失败时用）
JS_DOM_CARDS = r"""() => {
    const out = [];
    const text = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ');
    // 卡片候选：`job-card-pc-container` 是 get_jobs(Locators.JOB_CARDS) 的每卡容器语义类；
    // 其余为稳定属性 / URL 形态。**禁止**加入 CSS Modules 哈希类名（每次发布都变）。
    const cards = Array.from(document.querySelectorAll(
        'div[class*="job-card-pc-container"], a[data-nick="job-detail-job-info"], li[data-tlg-ext], [class*="job-card"], [class*="jobCard"], li'
    ));
    // jobId 提取（get_jobs(Liepin.java)::extractJobIdFromCard 口径）：
    // data-tlg-ext 先 URL 解码再 JSON 解析 → 退回转义正则 → 退回解码后正则 → data-tlg-scm 的 jobId=
    const jobIdFromCard = (c) => {
        const ext = c.getAttribute('data-tlg-ext') || '';
        if (ext) {
            try {
                const obj = JSON.parse(decodeURIComponent(ext));
                if (obj && obj.jobId) return String(obj.jobId);
            } catch (e) {}
            let m = ext.match(/jobId[\\":=]+(\d+)/);
            if (m) return m[1];
            try {
                m = decodeURIComponent(ext).match(/jobId[\\":=]+(\d+)/);
                if (m) return m[1];
            } catch (e) {}
        }
        const scm = c.getAttribute('data-tlg-scm') || '';
        const m2 = scm.match(/jobId=(\d+)/);
        return m2 ? m2[1] : '';
    };
    const seen = new Set();
    for (const c of cards) {
        if (seen.has(c)) continue; seen.add(c);
        const t = text(c);
        if (!t || t.length < 10 || t.length > 900) continue;
        const a = c.querySelector('a[href*="/job/"]');
        let jobId = jobIdFromCard(c);
        if (!jobId && a && a.href) {
            const m = a.href.match(/job[\\/]*(\d+)/);
            if (m) jobId = m[1];
        }
        if (!jobId) continue;
        out.push({
            platform: 'liepin',
            jobId: String(jobId),
            title: text(c.querySelector('[class*="job-title"], [class*="ellipsis-1"], h3') || c).slice(0, 120) || '岗位',
            company: text(c.querySelector('[class*="company"], [class*="comp-name"]') || c).slice(0, 80) || '',
            salary: text(c.querySelector('[class*="salary"], [class*="job-salary"]') || c).slice(0, 40) || '',
            location: text(c.querySelector('[class*="area"], [class*="dq"], [class*="address"]') || c).slice(0, 60) || '',
            experience: '', degree: '', labels: [], skills: [], description: '',
            recruiterName: text(c.querySelector('[class*="recruiter"], [class*="hr-name"], [class*="name"]') || c).slice(0, 40) || '',
            bossTitle: '', companySize: '', companyType: '', industry: '',
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

# 聊天窗元素选择器取自 get_jobs Locators.CHAT_HEADER(.__im_basic__header-wrap) /
# CHAT_CLOSE(div.__im_basic__contacts-title svg) —— 猎聘 IM 面板真机口径。
# 已建立会话确认：① IM 面板头部挂载（get_jobs 判定，真机验证）
#                    ② 按钮态变「继续聊」（已建会话）③ 输入区出现（兜底）
# ⚠️ 不得把「猜选择器」当主判据：确认失败会落到「未确认不计成功」，而岗位其实已投出。
JS_CHAT_ESTABLISHED = r"""() => {
    if (document.querySelector('.__im_basic__header-wrap')) return true;
    const text = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ');
    const visible = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch(e) { return false; } };
    const all = Array.from(document.querySelectorAll('button, a, [role="button"], span, div'));
    const hasContinue = all.some(el => visible(el) && /^继续\s*聊$/.test(text(el)) && text(el).length <= 8);
    const hasChatInput = !!document.querySelector('#chat-input, [contenteditable="true"], textarea');
    return hasContinue || hasChatInput;
}"""

# 投递成功后的收尾：关闭聊天窗口（① get_jobs 的 IM 面板关闭图标 → ② 通用关闭按钮兜底）
JS_CLOSE_CHAT = r"""() => {
    const closeIcon = document.querySelector('div.__im_basic__contacts-title svg');
    if (closeIcon) {
        try { closeIcon.click(); return; } catch (e) {}
    }
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

    def match_api_url(self, url: str) -> bool:
        """排除 `pc-search-job-cond-init`：同前缀的筛选字典接口，返回的不是岗位列表。

        （get_jobs(Liepin.java) 在请求/响应两侧同样显式排除该接口。）
        """
        return super().match_api_url(url) and 'pc-search-job-cond-init' not in (url or '')

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
