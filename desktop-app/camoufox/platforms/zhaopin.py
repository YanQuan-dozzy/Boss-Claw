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

本模块只保留**平台差异**（常量表 / JS 选择器 / 接口解析 / 按钮定位与确认），
搜索·投递·登录三段骨架统一由 `base.CollectorBase` 提供（对齐 BossHunter 分层）。
"""
import re

from .base import CollectorBase
from .common import DAILY_LIMIT_RE, human_sleep, log
from .filters import build_filter_params
from .models import JobCandidate

PLATFORM = 'zhaopin'

# jl 城市码（公开爬虫口径；未知城市省略 = 全国；省级码：548 = 全广东，实测用户链接）
CITY_CODES = {
    '全国': '', '北京': '530', '上海': '489', '深圳': '765', '天津': '532',
    '重庆': '481', '广州': '763', '杭州': '653', '成都': '801', '武汉': '736',
    '南京': '635', '苏州': '639', '西安': '854', '郑州': '713', '长沙': '749',
    '青岛': '857', '厦门': '683', '沈阳': '483', '大连': '682', '济南': '636',
    '广东': '548',
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


def build_search_url(query: str, city: str, salary: str, page: int = 1,
                     criteria: dict | None = None) -> str:
    """智联搜索 URL：路径式 jl{城市}/p{页码} + 关键词 + 薪资 + 「基础求职条件」筛选参数。

    criteria 经 filters.build_filter_params 翻译为智联自身参数：
      we 经验（0001 1年以下/1年以内、0103 1-3年、0305 3-5年、0510 5-10年 实测；-1 经验不限/1099 10年以上 字典码）· el 学历（3硕士/4本科/5大专/7高中）·
      ct 公司性质（1国企/2外企/5民营）· fs 融资阶段（8不需要融资/1未融资/
      有融资聚合 2;3;4;5;6，用户实测）·
      cs 公司规模（2=20-99/3=100-299/8=300-499/4=500-999 实测；「100-499人」档聚合 cs=3,8）· et 职位类型（2全职/4实习/1兼职/5校招，用户实测链接）。
    码值口径与能力表见 `filters.py`（2026-09 逐值实测，勿回退旧官方字典码）。
    """
    code = _resolve_city(city)
    sal = _resolve_salary(salary or ((criteria or {}).get('salary') or ''))
    url = f"https://www.zhaopin.com/sou/{f'jl{code}' if code else ''}/p{max(1, page)}"
    parts = []
    if sal:
        parts.append(f"sl={sal}")
    q = str(query or '').strip()
    if q:
        parts.append(f"kw={q}")
    for k, v in build_filter_params(PLATFORM, criteria).items():
        parts.append(f"{k}={v}")
    if parts:
        url += '?' + '&'.join(parts)
    return url


def format_jobs(raw: list, keyword: str = '', page: int = 0) -> list:
    """智联 fe-api results → 统一 `JobCandidate` 列表。"""
    out = []
    for j in raw:
        jid = j.get('number') or j.get('jobId') or ''
        if not jid:
            continue
        out.append(JobCandidate(
            platform=PLATFORM,
            jobId=str(jid),
            title=j.get('jobName') or '',
            company=j.get('company') or j.get('companyName') or '',
            salary=j.get('salary') or '',
            location=j.get('city') or j.get('cityName') or '',
            experience=j.get('workingExp') or '',
            degree=j.get('eduLevel') or '',
            labels=j.get('welfare') if isinstance(j.get('welfare'), list) else [],
            recruiterName=j.get('hrName') or '',
            bossTitle=j.get('hrTitle') or '',
            companySize=j.get('companySize') or j.get('companySizeName') or '',
            companyType=j.get('companyType') or '',
            url=j.get('positionURL') or j.get('positionUrl') or '',
            sourceKeyword=str(keyword or ''),
            sourcePage=int(page or 0),
        ))
    return out


# 页内搜索框输入关键词（路径式 URL 不带 kw）
JS_TYPE_KEYWORD = r"""(kw) => {
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
}"""

# DOM 卡片兜底提取（接口拦截失败时用）
JS_DOM_CARDS = r"""() => {
    const out = [];
    const text = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ');
    const cards = Array.from(document.querySelectorAll('[class*="joblist-box"] a, [class*="joblist"] a, [class*="job-card"], a[href*="/jobdetail/"]'));
    const seen = new Set();
    for (const c of cards) {
        const a = c.matches('a') ? c : c.querySelector('a');
        const href = a ? a.href : '';
        if (!href || seen.has(href)) continue; seen.add(href);
        const m = href.match(/jobdetail\/([^/?]+)/i);
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
}"""

# 投递按钮定位（返回状态机：ready / delivered / external / not_found）
JS_FIND_DELIVER_BTN = r"""() => {
    const all = Array.from(document.querySelectorAll('button, a, [role="button"], span, div'));
    const text = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ');
    const visible = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch(e) { return false; } };
    const hits = all.filter(el => visible(el) && text(el).length <= 10 && /投递/.test(text(el)));
    if (!hits.length) return 'not_found';
    hits.sort((a, b) => text(b).length - text(a).length);
    const label = text(hits[0]);
    const el = hits[0];
    if (/已\s*投递/.test(label)) return 'delivered';
    if (/网申|前往申请|企业官网/.test(label)) return 'external';
    el.setAttribute('data-zhaopin-deliver', '1');
    return 'ready';
}"""

# 投递成功确认：弹层/toast 含「投递成功/投递完成」或按钮态「已投递」
JS_DELIVER_CONFIRMED = r"""() => {
    const text = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ');
    const visible = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch(e) { return false; } };
    const body = (document.body ? document.body.innerText : '') || '';
    if (/投递成功|投递完成/.test(body.slice(0, 4000))) return true;
    const all = Array.from(document.querySelectorAll('button, a, [role="button"], span, div'));
    return all.some(el => visible(el) && /^已\s*投递$/.test(text(el)) && text(el).length <= 8);
}"""


class ZhaopinCollector(CollectorBase):
    platform = PLATFORM
    label = '智联招聘'
    home_url = 'https://www.zhaopin.com'
    login_url = 'https://passport.zhaopin.com/login'
    login_host = 'zhaopin.com'
    api_hint = SEARCH_API_HINT
    detail_markers = ('/jobdetail',)
    capture_wait_attempts = 8
    # 支持「已投递」短路与「外部网申」跳过（智联特有状态机）
    supports_already_sent = True
    supports_external_skip = True
    # 平台侧每日投递上限提示（复用 common 的通用判定词）
    limit_re = DAILY_LIMIT_RE

    # ---------- 采集差异 ----------
    def build_search_url(self, query, city, salary, page=1, criteria=None) -> str:
        return build_search_url(query, city, salary, page, criteria)

    def parse_api_payload(self, root: dict) -> list:
        """fe-api /c/i/sou → data.results。"""
        data = (root or {}).get('data') or {}
        results = data.get('results') if isinstance(data, dict) else None
        return results if isinstance(results, list) else []

    def format_jobs(self, raw, keyword='', page=0) -> list:
        return format_jobs(raw, keyword, page)

    def dom_cards_js(self) -> str:
        return JS_DOM_CARDS

    def after_navigate(self, page, query: str, page_num: int) -> None:
        """路径式 URL 不带关键词 → 第 1 页在页内搜索框输入并回车。"""
        if page_num != 1:
            return
        q = str(query or '').strip()
        if not q:
            return
        try:
            if page.evaluate(JS_TYPE_KEYWORD, q):
                page.keyboard.press('Enter')
                human_sleep(2.2, 0.3, 1.2)
        except Exception as e:
            log('⚠️', f'[{self.platform}] 搜索框输入失败：{e}')

    # ---------- 投递差异 ----------
    def find_action_button(self, page):
        """状态机：ready / already(已投递) / external(外部网申) / not_found。"""
        try:
            state = page.evaluate(JS_FIND_DELIVER_BTN)
        except Exception:
            return 'not_found', None
        if state == 'delivered':
            return 'already', None
        if state == 'external':
            return 'external', None
        if state != 'ready':
            return 'not_found', None
        loc = page.locator('[data-zhaopin-deliver]').first
        return ('ready', loc) if loc.count() > 0 else ('not_found', None)

    def confirm_sent(self, page) -> bool:
        try:
            return bool(page.evaluate(JS_DELIVER_CONFIRMED))
        except Exception:
            return False

    def missing_button_message(self) -> str:
        return '未找到「投递」按钮（岗位可能已下架）'

    def limit_message(self) -> str:
        return '智联招聘今日投递已达上限，已停止，请明日再试或人工处理'

    def already_sent_method(self) -> str:
        return 'zhaopin-already'

    def success_method(self) -> str:
        return 'zhaopin-deliver'


# ============================================================
# 模块级薄壳（保持 server 调用签名不变）
# ============================================================
_COLLECTOR = ZhaopinCollector()


def search_jobs(query: str, city: str, pages: int = 1, os_name: str | None = None,
                criteria: dict | None = None, force: bool = False,
                config: dict | None = None) -> dict:
    """智联隐身搜索：访问搜索页（页内输入关键词）+ 拦截 fe-api 响应 + DOM 兜底。"""
    return _COLLECTOR.search_jobs(query, city, pages, os_name, criteria, force, config)


def deliver(job: dict, greeting: str, os_name: str | None = None,
            send_resume_image: bool = False, send_online_resume: bool = False,
            expected: dict | None = None, resume_images: list | None = None,
            mode: str = 'auto', reply_text: str | None = None) -> dict:
    """智联投递：打开岗位详情 → 点「投递」→ 确认投递成功（未确认不计成功）。"""
    return _COLLECTOR.deliver(job, greeting, os_name, send_resume_image, send_online_resume,
                              expected, resume_images, mode, reply_text)


def do_login(timeout: int = 180, os_name: str | None = None) -> dict:
    """打开可见窗口扫码登录智联招聘，Cookie 持久化。"""
    return _COLLECTOR.do_login(timeout, os_name)
