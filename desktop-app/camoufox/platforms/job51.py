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

本模块只保留**平台差异**（常量表 / JS 选择器 / 接口解析 / 按钮定位与确认），
搜索·投递·登录三段骨架统一由 `base.CollectorBase` 提供（对齐 BossHunter 分层）。
"""
import re

from .base import CollectorBase
from .common import human_sleep, log
from .filters import build_filter_params
from .models import JobCandidate

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
# 每日搜索/投递受限提示（瞬态 toast；词表对齐 get_jobs(Job51.java)::detectDailyLimitToast51job，
# 「达到上限 / 次数过多 / 休息一下明天再来」是平台实际文案，漏了就会继续投递直到被风控）
LIMIT_RE = re.compile(
    r'今日投递|您今日投递太多|达到上限|已达上限|投递上限|投递次数|次数过多|操作频繁|'
    r'休息一下明天再来|明天再来|请稍后再试'
)


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


def build_search_url(query: str, city: str, salary: str, page: int = 1,
                     criteria: dict | None = None) -> str:
    """51Job 搜索 URL：jobArea 城市 + salary 薪资 + keyword 关键词 + 「基础求职条件」筛选参数。

    criteria 经 filters.build_filter_params 翻译为 51Job 自身参数：
      workYear 经验 · degree 学历 · companySize 公司规模 · jobType 工作类型。
    注意：51Job 的码值为「顺位 2 位编码」推得（inferred，见 filters.py 能力表），
    真机登录实测后可逐项校准 filters.py 中的 JOB51_* 表。

    分页不经 URL：51Job 搜索页无可靠的 page 查询参数（get_jobs 亦如此），翻页由页内
    「跳页」控件完成 → `page` 形参在此**刻意不使用**，第 2 页起交给 `after_navigate` 跳页。
    """
    area = _resolve_area(city)
    sal = _resolve_salary(salary or ((criteria or {}).get('salary') or ''))
    parts = []
    if area:
        parts.append(f"jobArea={area}")
    if sal:
        parts.append(f"salary={sal}")
    q = str(query or '').strip()
    if q:
        parts.append(f"keyword={q}")
    for k, v in build_filter_params(PLATFORM, criteria).items():
        parts.append(f"{k}={v}")
    return 'https://we.51job.com/pc/search' + ('?' + '&'.join(parts) if parts else '')


def format_jobs(raw: list, keyword: str = '', page: int = 0) -> list:
    """51job search-pc 结果 → 统一 `JobCandidate` 列表。"""
    out = []
    for j in raw:
        jid = j.get('jobId') or j.get('jobid') or ''
        if not jid:
            continue
        out.append(JobCandidate(
            platform=PLATFORM,
            jobId=str(jid),
            title=j.get('jobName') or j.get('job_title') or '',
            company=j.get('companyName') or j.get('company_name') or '',
            salary=j.get('salary') or j.get('salaryString') or '',
            location=j.get('jobArea') or j.get('job_area') or j.get('cityName') or '',
            experience=j.get('workExp') or '',
            degree=j.get('eduLevel') or '',
            labels=j.get('jobTags') if isinstance(j.get('jobTags'), list) else [],
            description=j.get('jobDesc') or '',
            companySize=j.get('companySize') or '',
            companyType=j.get('companyType') or '',
            url=j.get('jobHref') or (f"https://jobs.51job.com/all/{jid}.html" if jid else ''),
            sourceKeyword=str(keyword or ''),
            sourcePage=int(page or 0),
        ))
    return out


# DOM 卡片兜底提取（接口拦截失败时用）
JS_DOM_CARDS = r"""() => {
    const out = [];
    const text = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ');
    const anchors = Array.from(document.querySelectorAll("a[href*='/pc/jobdetail?jobId='], a[href*='jobs.51job.com/'], a[href*='/pc/jobdetail']"));
    const seen = new Set();
    for (const a of anchors) {
        if (!a.href || seen.has(a.href)) continue; seen.add(a.href);
        const m = a.href.match(/jobId=(\d+)/i) || a.href.match(/jobs\.51job\.com\/([^\/]+)/i);
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
}"""

# 空结果文案（对齐 get_jobs(Job51.java)::detectNoJobs51job）
JS_NO_JOBS = r"""() => {
    const kws = ['暂无职位', '没有符合条件的职位', '暂无符合条件职位', '暂无符合职位', '暂无相关职位'];
    const body = (document.body ? document.body.innerText : '') || '';
    return kws.some(k => body.includes(k));
}"""

# 页内跳页（对齐 get_jobs(Job51.java)::jumpToPage：页码输入框 #jump_page + 跳转控件 .jumpPage）
JS_JUMP_TO_PAGE = r"""(pageNum) => {
    const input = document.querySelector('#jump_page');
    if (!input) return false;
    try { input.focus(); } catch (e) {}
    input.value = String(pageNum);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const btn = document.querySelector('span.jumpPage, .jumpPage');
    if (btn) { btn.click(); return true; }
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
    return true;
}"""

# 投递按钮定位：① 列表页「批量投递」控件（get_jobs(Job51.java) 真机口径：
# div.tabs_in 下第 2 个 button.p_but）→ ② 详情页按**精确文案**匹配投递类按钮。
# ⚠️ 不得再用「文本含『投递』+ 按文本长度排序」的宽泛启发式：它会命中任意含该字的
# 容器/导航项，点击对象不可预期（旧实现对文本长度降序取首个，语义不明）。
JS_FIND_DELIVER_BTN = r"""() => {
    const text = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ');
    const visible = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch(e) { return false; } };
    const mark = (el) => { el.setAttribute('data-job51-deliver', '1'); return true; };
    const batch = Array.from(document.querySelectorAll('div.tabs_in button.p_but')).filter(visible);
    if (batch.length > 1) return mark(batch[1]);
    const APPLY_RE = /^(批量投递|立即投递|投递简历|立即申请|申请职位|投递)$/;
    const DONE_RE = /已投递|投递成功|已申请/;
    const hits = Array.from(document.querySelectorAll('button, a, [role="button"]'))
        .filter(el => visible(el) && APPLY_RE.test(text(el)));
    const ready = hits.find(el => !DONE_RE.test(text(el)));
    return ready ? mark(ready) : false;
}"""

# 投递成功确认：① 结果弹窗「投递成功 N 个，未投递 M 个」（get_jobs(Job51.java) 真机口径：
# .el-dialog__body 含「投递成功」）→ ② toast / 正文兜底
JS_DELIVER_CONFIRMED = r"""() => {
    const dlg = document.querySelector('.el-dialog__body');
    if (dlg && /投递成功/.test(dlg.innerText || '')) return true;
    const body = (document.body ? document.body.innerText : '') || '';
    return /投递成功|成功投递|投递完成|已投递\s*\d+|投递\s*\d+\s*份/.test(body.slice(0, 4000));
}"""


class Job51Collector(CollectorBase):
    platform = PLATFORM
    label = '前程无忧'
    home_url = 'https://we.51job.com'
    login_url = 'https://we.51job.com/pc/login'
    login_host = '51job.com'
    api_hint = SEARCH_API_HINT
    detail_markers = ('/pc/jobdetail', 'jobs.51job.com')
    capture_wait_attempts = 8
    # 平台侧操作受限提示（今日投递/已达上限/操作频繁）
    limit_re = LIMIT_RE

    # ---------- 采集差异 ----------
    def build_search_url(self, query, city, salary, page=1, criteria=None) -> str:
        return build_search_url(query, city, salary, page, criteria)

    def parse_api_payload(self, root: dict) -> list:
        """`/api/job/search-pc` → 岗位列表。

        候选路径与 get_jobs(Job51.java)::extractJobIdsFromJson 的清单对齐
        （items / jobList / list / jobs / resultbody.job.items / job.items / resultbody.items，
        get_jobs 按此顺序兜底），另保留既有的 `data.result` 分支（含 dict 包裹）。
        只认已知结构，不猜字段名；全部落空返回 []，交给 DOM 兜底。
        """
        root = root if isinstance(root, dict) else {}
        data = root.get('data') if isinstance(root.get('data'), dict) else {}
        resultbody = root.get('resultbody') if isinstance(root.get('resultbody'), dict) else {}
        nested_job = resultbody.get('job') if isinstance(resultbody.get('job'), dict) else {}
        top_job = root.get('job') if isinstance(root.get('job'), dict) else {}

        candidates = (
            data.get('items'), data.get('jobList'), data.get('list'), data.get('jobs'),
            data.get('result'),
            resultbody.get('items'), nested_job.get('items'), top_job.get('items'),
        )
        for cand in candidates:
            if isinstance(cand, list):
                return cand
            if isinstance(cand, dict):
                for key in ('list', 'jobs', 'items'):
                    inner = cand.get(key)
                    if isinstance(inner, list):
                        return inner
        return []

    def format_jobs(self, raw, keyword='', page=0) -> list:
        return format_jobs(raw, keyword, page)

    def dom_cards_js(self) -> str:
        return JS_DOM_CARDS

    def after_navigate(self, page, query, page_num) -> bool | None:
        """分页：页内「跳页」控件（`#jump_page` + `.jumpPage`，get_jobs 真机口径）。

        骨架逐页 goto 同一 URL（51Job 无可靠 page 查询参数），故第 2 页起在此处跳页；
        返回 True 让骨架丢弃跳页前捕获的响应（否则首页列表会混进本页）。
        跳页控件缺失只告警不中断——不把「控件变更」伪装成采集失败（宁少采不误判）。
        """
        if page_num <= 1:
            return None
        try:
            jumped = bool(page.evaluate(JS_JUMP_TO_PAGE, page_num))
        except Exception as e:
            jumped = False
            log('⚠️', f'[job51] 跳到第 {page_num} 页异常：{e}')
        if not jumped:
            log('⚠️', f'[job51] 未找到跳页控件，#{page_num} 页可能仍是上一页内容')
            return None
        human_sleep(2.0, 0.35, 1.2)
        return True

    def empty_list_hit(self, page) -> bool:
        """空结果判定（文案对齐 get_jobs::detectNoJobs51job）→ 本词提前收口翻页。"""
        try:
            return bool(page.evaluate(JS_NO_JOBS))
        except Exception:
            return False

    def is_logged_out(self, page) -> bool:
        """未登录判定：页头 `a.uname` 文案为「登录」（get_jobs::checkNeedLogin 口径）。

        51Job 未登录不跳转 /login，只看 URL 会把「未登录」误判成「找不到投递按钮」。
        """
        try:
            return bool(page.evaluate(
                r"""() => {
                    const a = document.querySelector('a.uname');
                    if (!a) return false;
                    return /登录/.test((a.textContent || '').trim());
                }"""
            ))
        except Exception:
            return False

    # ---------- 投递差异 ----------
    def find_action_button(self, page):
        try:
            ok = page.evaluate(JS_FIND_DELIVER_BTN)
        except Exception:
            return 'not_found', None
        if not ok:
            return 'not_found', None
        loc = page.locator('[data-job51-deliver]').first
        return ('ready', loc) if loc.count() > 0 else ('not_found', None)

    def confirm_sent(self, page) -> bool:
        try:
            return bool(page.evaluate(JS_DELIVER_CONFIRMED))
        except Exception:
            return False

    def missing_button_message(self) -> str:
        return '未找到「投递」按钮（岗位可能已下架或已投递）'

    def limit_message(self) -> str:
        return '51Job 触发操作受限提示，已停止，请人工处理'

    def success_method(self) -> str:
        return 'job51-deliver'


# ============================================================
# 模块级薄壳（保持 server 调用签名不变）
# ============================================================
_COLLECTOR = Job51Collector()


def search_jobs(query: str, city: str, pages: int = 1, os_name: str | None = None,
                criteria: dict | None = None, force: bool = False,
                config: dict | None = None) -> dict:
    """51Job 隐身搜索：访问搜索页 + 拦截 /api/job/search-pc 响应 + DOM 兜底。"""
    return _COLLECTOR.search_jobs(query, city, pages, os_name, criteria, force, config)


def deliver(job: dict, greeting: str, os_name: str | None = None,
            send_resume_image: bool = False, send_online_resume: bool = False,
            expected: dict | None = None, resume_images: list | None = None,
            mode: str = 'auto', reply_text: str | None = None) -> dict:
    """51Job 投递：打开岗位 → 点「投递」→ 确认投递成功（未确认不计成功）。"""
    return _COLLECTOR.deliver(job, greeting, os_name, send_resume_image, send_online_resume,
                              expected, resume_images, mode, reply_text)


def do_login(timeout: int = 180, os_name: str | None = None) -> dict:
    """打开可见窗口扫码登录前程无忧，Cookie 持久化。"""
    return _COLLECTOR.do_login(timeout, os_name)
