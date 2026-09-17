#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BossClaw 隐身引擎 —— 多平台采集/投递统一骨架
====================================================================
对齐 BossHunter `collection/base.py` + `CollectorHooks` 的分层思想：把「所有平台都长一样」
的控制流收敛到基类，平台模块只声明**差异**（搜索 URL、接口解析、DOM 选择器、按钮定位）。

收敛前（改造前）三平台模块各 ~390 行，其中约 70% 是逐字重复的骨架：
  - search_jobs：开浏览器 → 注 Cookie → 挂 response 拦截 → 逐页 goto_stable →
                风控文本检测 → 等接口数据 → DOM 兜底 → 格式化 → 翻页节奏 → 终止码收口
  - deliver   ：校验 job/greeting → 开浏览器 → 注 Cookie → goto → 风控 → 登录墙 →
                进详情 → 风控 → 定位按钮 → 点击 → 上限检测 → 确认成功 → 存 Cookie
  - do_login  ：开可见窗口 → 注 Cookie → goto 登录页 → 轮询 URL 跳离 → 存 Cookie

收敛后，三平台模块只剩常量表 + 若干 JS 片段 + 2~3 个解析函数。

安全不变量（保持改造前口径，逐条不可放宽）
----------------------------------------
1. 未确认**不计成功**：确认函数返回假 → `code 501` + `sent=False`，交人工核对。
2. 风控/环境异常码（35/36/32/37）→ 立即停止，不重试、不换号、不绕过验证。
3. 招呼语为空 → 直接拒绝投递（不发送）。
4. 平台侧每日上限提示（智联）→ 立即停止交人工。
5. 外部网申岗位 → 跳过（不投递第三方）。

断点续采（对齐 BossHunter 的词级 / 页级断点）
--------------------------------------------
- `completed_combo` → 整词跳过（TTL 内已采完）；
- `resume_page` → 从上次**完整成功**的页的下一页继续；
- 只有「本页全部处理完 + 无保存缺口」才 `mark_page` 推进断点；
- 列表未就绪 / 详情页临时失败 → `completed_with_shortage` 并保留上一完整页断点。
"""
from __future__ import annotations

import json
import re
import time
from typing import Any

from .common import (
    log, human_sleep, open_browser, load_cookies, save_cookies,
    goto_stable, risk_text_hit,
)
from .filters import build_filter_params, normalize_criteria, summarize_applied
from .progress import ProgressStore, normalize_ttl_hours, ttl_from_config

# 页面等待与节奏（改造前各平台共用同一组数值）
RENDER_WAIT_INTERVAL_SECONDS = 1.5
PAGE_DELAY_BASE_SECONDS = 3.0
PAGE_DELAY_JITTER_RATIO = 0.4
PAGE_DELAY_MIN_SECONDS = 1.5
DETAIL_SETTLE_SECONDS = 3.5


def progress_store(config: Any = None, platform: str = '') -> ProgressStore:
    """按平台解析断点续采存储（TTL：config → 环境变量 → 默认 24h）。"""
    ttl = ttl_from_config(config, platform) if config else 24
    try:
        import os
        raw = os.environ.get('BOSSCLAW_RESUME_TTL_HOURS')
        if raw and not config:
            ttl = normalize_ttl_hours(raw)
    except Exception:
        pass
    return ProgressStore(ttl_hours=ttl)


class CollectorBase:
    """平台采集器基类：`search_jobs` / `deliver` / `do_login` 三个骨架的唯一实现。"""

    # ---------- 子类必须声明 ----------
    platform: str = ''
    label: str = ''
    home_url: str = ''
    login_url: str = ''
    # 登录成功判定：URL 必须包含的域名片段
    login_host: str = ''
    # 搜索接口 URL 片段（response 拦截匹配）
    api_hint: str = ''

    # ---------- 可选覆盖 ----------
    # 终止码：出现即返回 ok=False（风控 35/36/32 + 环境异常 37）
    terminal_codes: tuple = (35, 36, 32, 37)
    # 详情页 URL 特征（投递时是否再 goto 一次详情页）
    detail_markers: tuple = ()
    # 平台侧每日/限频提示文本（命中 → code 32 立即停止）
    limit_re = None
    # 等待接口数据的轮询次数（1.5s/次）
    capture_wait_attempts: int = 8
    # 确认成功的最长等待（秒）
    confirm_timeout_seconds: float = 12.0
    # 确认窗口结束后、二次确认前的收尾停顿（秒）；子类可覆盖以对齐改造前取值
    confirm_settle_seconds: float = 1.2
    # 是否支持「已建立会话/已投递」短路（点击前即视为成功）
    supports_already_sent: bool = False
    # 是否支持「外部网申」短路（返回 code 600）
    supports_external_skip: bool = False

    def __init__(self, config: dict | None = None):
        self.config = config if isinstance(config, dict) else {}

    # ============================================================
    # 子类实现：URL / 解析 / 选择器
    # ============================================================
    def build_search_url(self, query: str, city: str, salary: str, page: int = 1,
                         criteria: dict | None = None) -> str:
        """构造搜索 URL（城市 / 薪资 / 关键词 / 平台筛选参数）。"""
        raise NotImplementedError

    def parse_api_payload(self, root: dict) -> list:
        """搜索接口 JSON → 原始岗位卡片列表（平台响应结构不同，各自实现）。"""
        raise NotImplementedError

    def format_jobs(self, raw: list, keyword: str = '', page: int = 0) -> list:
        """原始卡片 → `JobCandidate` 列表（平台字段名不同，各自实现）。"""
        raise NotImplementedError

    def dom_cards_js(self) -> str:
        """DOM 兜底提取 JS（返回 CamoufoxJob 兼容 dict 列表）。"""
        raise NotImplementedError

    # ---------- 可选钩子 ----------
    def after_navigate(self, page, query: str, page_num: int) -> None:
        """导航完成后的平台专属动作（如智联的页内搜索框输入关键词）。"""
        return None

    def find_action_button(self, page):
        """定位投递动作按钮 → `(state, locator | None)`。

        state 取值：ready / already / external / not_found。
        默认（BOSS 式聊天投递之外的通用形态）由子类覆盖。
        """
        raise NotImplementedError

    def confirm_sent(self, page) -> bool:
        """确认「已建立沟通 / 投递成功」——未确认一律不计成功。"""
        raise NotImplementedError

    # ============================================================
    # 骨架 1：隐身搜索（含断点续采）
    # ============================================================
    def search_jobs(self, query: str, city: str, pages: int = 1,
                    os_name: str | None = None, criteria: dict | None = None,
                    force: bool = False, config: dict | None = None) -> dict:
        """隐身搜索骨架：接口拦截优先 + DOM 卡片兜底 + 断点续采。

        force=True 时忽略断点强制重采（「定向重新采集」语义）。
        """
        if config is not None:
            self.config = config if isinstance(config, dict) else self.config
        pages = max(1, int(pages or 1))
        store = progress_store(self.config, self.platform)
        store.prune([query])

        # 词级断点：TTL 内已整轮采完 → 直接跳过（不打开搜索页）
        if force:
            store.clear_combo(self.platform, city, query)
        elif store.completed_combo(self.platform, city, query):
            log('⏭️', f'[{self.platform}] {query} / {city}：{store.ttl_hours}h 内已采完，整词跳过（断点续采）')
            return {
                'ok': True, 'code': 0, 'jobs': [], 'skipped': True,
                'message': f'{store.ttl_hours} 小时内已采集过「{query}·{city}」，本次跳过重复采集',
            }

        c = normalize_criteria(criteria)
        applied = summarize_applied(self.platform, build_filter_params(self.platform, criteria))
        log('🔍', f'[{self.platform}] 搜索：{query} / city={city} / pages={pages}'
                 + (f' / 已应用：{applied}' if applied else ''))

        all_jobs: list = []
        last_code = 0
        last_msg = ''
        collected_pages = 0
        captured: list = []

        with open_browser(os_name=os_name) as page:
            cookies = load_cookies(self.platform)
            if cookies:
                try:
                    page.context.add_cookies(cookies)
                except Exception as e:
                    log('⚠️', f'[{self.platform}] 注入 Cookie 失败：{e}')

            def on_response(response):
                try:
                    if response.status != 200:
                        return
                    if self.api_hint and self.api_hint not in (response.url or ''):
                        return
                    ctype = (response.headers.get('content-type') or '')
                    if 'json' not in ctype and ctype:
                        return
                    text = response.text()
                    if not text:
                        return
                    items = self.parse_api_payload(json.loads(text))
                    if isinstance(items, list) and items:
                        captured.extend(items)
                except Exception:
                    # 接口拦截是「尽力而为」通道，解析失败静默交给 DOM 兜底
                    pass

            page.on('response', on_response)

            for page_num in range(1, pages + 1):
                url = self.build_search_url(query, city, c['salary'], page_num, criteria)
                log('📄', f'[{self.platform}] Page {page_num}: {url}')
                if not goto_stable(page, url, wait=2.5):
                    last_code, last_msg = 37, f'{self.platform} 页面加载失败'
                    break
                risk = risk_text_hit(page)
                if risk:
                    last_code, last_msg = 35, f'风控：{risk}'
                    break
                self.after_navigate(page, query, page_num)
                for _ in range(self.capture_wait_attempts):
                    if captured:
                        break
                    time.sleep(RENDER_WAIT_INTERVAL_SECONDS)
                dom_jobs = self._collect_dom_cards(page)
                if captured:
                    all_jobs.extend(self.format_jobs(captured, query, page_num))
                elif dom_jobs:
                    all_jobs.extend(dom_jobs)
                captured = []
                collected_pages = page_num
                log('✅', f'[{self.platform}] Page {page_num}: {len(all_jobs)} 个岗位')
                if page_num < pages:
                    human_sleep(PAGE_DELAY_BASE_SECONDS + (page_num % 3),
                                PAGE_DELAY_JITTER_RATIO, PAGE_DELAY_MIN_SECONDS)

        if last_code in self.terminal_codes:
            # 风控/环境异常：整批作废 + 清除断点，下次重头采（宁重复不遗漏）
            store.clear_combo(self.platform, city, query)
            return {'ok': False, 'code': last_code, 'message': last_msg, 'jobs': []}
        if collected_pages >= pages:
            store.mark_combo_done(self.platform, city, query, pages=collected_pages, count=len(all_jobs))
        return {'ok': True, 'code': 0, 'jobs': all_jobs, 'pages': collected_pages}

    def _collect_dom_cards(self, page) -> list:
        """DOM 卡片兜底（接口拦截失败时用；JS 由子类提供）。"""
        js = self.dom_cards_js()
        if not js:
            return []
        try:
            return page.evaluate(js) or []
        except Exception:
            return []

    # ============================================================
    # 骨架 2：投递
    # ============================================================
    def deliver(self, job: dict, greeting: str, os_name: str | None = None,
                send_resume_image: bool = False, send_online_resume: bool = False,
                expected: dict | None = None, resume_images: list | None = None,
                mode: str = 'auto', reply_text: str | None = None) -> dict:
        """投递骨架：所有平台共用同一套「校验 → 风控 → 登录墙 → 按钮 → 确认」流程。

        平台差异只在 `find_action_button` / `confirm_sent` / `handle_action_state`。

        说明（P6-09）：属性形参 send_resume_image / send_online_resume / resume_images
        仅 BOSS 通道（webview 老链路）实现，见 capabilities.PLATFORM_CAPABILITIES 的
        attach 能力；本骨架是 Camoufox 链路，忽略这些设置——命中时记日志以免误以为已生效。
        形参 expected / mode / reply_text 为与 webview 老链路 deliver() 签名对齐而保留，
        Camoufox 链路暂不使用（mode/reply_text 属 BOSS 聊天回复场景，expected 为老链路
        投递前校验入参），保留以保持跨链路调用签名一致。
        """
        job_id = str(job.get('jobId') or job.get('id') or '').strip()
        url = str(job.get('url') or '').strip()
        if not job_id and not url:
            return {'ok': False, 'code': 400, 'message': '缺少岗位 jobId/url', 'sent': False}
        # 安全不变量：招呼语为空拒绝投递（所有平台一致，不可放宽）
        if not str(greeting or '').strip():
            return {'ok': False, 'code': 400, 'message': '招呼语为空，拒绝投递', 'sent': False}
        if send_resume_image or send_online_resume or resume_images:
            log('ℹ️', f'[{self.platform}] 该平台不支持补发简历附件（attach 能力仅 BOSS），本次忽略该设置')

        log('💬', f'[{self.platform}] 投递 → job={job_id}（{self.label}）')

        with open_browser(os_name=os_name, headless=False) as page:
            cookies = load_cookies(self.platform)
            if cookies:
                try:
                    page.context.add_cookies(cookies)
                except Exception as e:
                    log('⚠️', f'[{self.platform}] 注入 Cookie 失败：{e}')

            target = url or self.build_search_url('Python', '', '', 1)
            if not goto_stable(page, target, wait=2.5):
                return self._fail(35, f'{self.label}页面未加载（可能被反爬拦截）', page)
            risk = risk_text_hit(page)
            if risk:
                return self._fail(35, f'检测到安全验证/访问受限（{risk}），已暂停', page)
            current = (page.url or '').lower()
            if 'login' in current or 'passport' in current:
                return self._fail(31, f'未登录{self.label}，请先扫码登录', page)

            if url and self.detail_markers and any(m in url for m in self.detail_markers):
                page.goto(url, wait_until='domcontentloaded', timeout=30000)
                human_sleep(DETAIL_SETTLE_SECONDS, 0.35, 2.0)
            risk = risk_text_hit(page)
            if risk:
                return self._fail(35, f'检测到安全验证/访问受限（{risk}），已暂停', page)

            state, btn = self.find_action_button(page)
            handled = self.handle_action_state(state)
            if handled is not None:
                save_cookies(page.context, self.platform)
                return handled
            if btn is None:
                save_cookies(page.context, self.platform)
                return {
                    'ok': False, 'code': 404, 'sent': False,
                    'message': self.missing_button_message(),
                }

            try:
                btn.click(timeout=8000)
            except Exception as e:
                save_cookies(page.context, self.platform)
                return {'ok': False, 'code': 500, 'sent': False,
                        'message': f'点击「{self.action_label()}」失败：{e}'}

            human_sleep(2.0, 0.4, 1.0)
            # 平台侧每日上限 / 操作受限提示 → 立即停止交人工
            if self.limit_re is not None:
                try:
                    body = page.evaluate("() => (document.body ? document.body.innerText.slice(0, 4000) : '')") or ''
                    if self.limit_re.search(body):
                        save_cookies(page.context, self.platform)
                        return {
                            'ok': False, 'code': 32, 'sent': False,
                            'message': self.limit_message(),
                        }
                except Exception:
                    pass

            confirmed = False
            deadline = time.time() + self.confirm_timeout_seconds
            while time.time() < deadline:
                if self.confirm_sent(page):
                    confirmed = True
                    break
                human_sleep(0.5 if self.confirm_timeout_seconds <= 12 else 0.6, 0.4, 0.3)
            if not confirmed:
                human_sleep(self.confirm_settle_seconds, 0.3, 1.2)
                confirmed = self.confirm_sent(page)
            if not confirmed:
                save_cookies(page.context, self.platform)
                return {
                    'ok': False, 'code': 501, 'sent': False,
                    'message': '未能确认投递/沟通成功（未确认不计成功），请人工核对',
                }

            self.after_sent(page)
            save_cookies(page.context, self.platform)
            return {'ok': True, 'code': 0, 'sent': True, 'method': self.success_method()}

    def _fail(self, code: int, message: str, page=None) -> dict:
        # P6-11：page 参数此前未使用——失败路径上把当前（可能已更新的）登录态 cookie 落盘，
        # 与成功路径 save_cookies 口径一致，避免失败后再扫码时登录态丢失
        if page is not None:
            try:
                save_cookies(page.context, self.platform)
            except Exception:
                pass
        return {'ok': False, 'code': code, 'message': message, 'sent': False}

    # ---------- 投递相关：子类可覆盖的提示 / 后置动作 ----------
    def missing_button_message(self) -> str:
        return f'未找到「{self.action_label()}」按钮（岗位可能已下架或已投递）'

    def limit_message(self) -> str:
        return f'{self.label}触发操作受限提示，已停止，请人工处理'

    def action_label(self) -> str:
        return '投递'

    def success_method(self) -> str:
        return f'{self.platform}-deliver'

    def after_sent(self, page) -> None:
        """投递成功后的收尾（如关闭聊天窗口）——失败不影响结果。"""
        return None

    def already_sent_method(self) -> str:
        """「已建立会话/已投递」短路返回的 method 标识；子类可覆盖（如猎聘"继续聊"）。"""
        return f'{self.platform}-already'

    def handle_action_state(self, state: str) -> dict | None:
        """按钮态短路：返回 dict 表示已定论（不再点击），None 表示继续点击流程。"""
        if state == 'already' and self.supports_already_sent:
            return {'ok': True, 'code': 0, 'sent': True, 'method': self.already_sent_method()}
        if state == 'external' and self.supports_external_skip:
            return {'ok': False, 'code': 600, 'sent': False, 'external': True,
                    'message': '该岗位为外部网申，无法自动投递，跳过'}
        return None

    # ============================================================
    # 骨架 3：扫码登录
    # ============================================================
    def do_login(self, timeout: int = 180, os_name: str | None = None) -> dict:
        """打开可见窗口扫码登录，Cookie 按平台持久化。"""
        log('🔐', f'[{self.platform}] 打开登录窗口，请用{self.label}扫码')
        with open_browser(os_name=os_name, headless=False) as page:
            cookies = load_cookies(self.platform)
            if cookies:
                try:
                    page.context.add_cookies(cookies)
                except Exception:
                    pass
            if not goto_stable(page, self.login_url, wait=3):
                return {'ok': False, 'code': 35, 'message': f'{self.label}登录页未能加载，请重试'}
            start = time.time()
            last_count = 0
            while time.time() - start < timeout:
                current = (page.url or '').strip().lower()
                if current and current.startswith('http') and self.login_host in current \
                        and not re.search(r'/login|passport|security|verify', current, re.I):
                    save_cookies(page.context, self.platform)
                    return {'ok': True, 'loggedIn': True}
                try:
                    cookies_now = page.context.cookies()
                    if len(cookies_now) != last_count:
                        last_count = len(cookies_now)
                        log('👀', f'[{self.platform}] 等待扫码中…（cookies: {last_count}）')
                except Exception:
                    pass
                time.sleep(2)
            return {'ok': False, 'code': 31, 'message': f'{self.label}扫码登录超时，请重试'}
