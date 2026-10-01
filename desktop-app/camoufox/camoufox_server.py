#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BossClaw 隐身引擎 —— 本地 Python 桥服务（仅 Camoufox 原生隐身内核）
============================================================
为 Boss-claw 桌面版提供隐身采集 / 投递能力。**只用 Camoufox 隐身引擎**：
实测 BOSS 会对 Playwright 驱动的系统 Chrome/Edge 返回空壳页（约 39 字节空 HTML），
因此**本地浏览器内核不能复用**，必须使用 `camoufox fetch` 下载的原生内核
（C++ 级指纹伪装 + humanize，可正常加载 BOSS 并完成登录/沟通）。

  - 引擎：Camoufox 原生内核（需先 `pip install "camoufox[geoip]" && camoufox fetch`）
  - 未装内核 → /status 返回 not ready，前端提示安装隐身引擎内核

能力（对齐 boss-auto-job-main）：
  - /status  检测可用内核与引擎状态
  - /search  隐身搜索（humanize/stealth，自动处理 code 37 环境检查）
  - /send    隐身发送招呼语（friend/add.json API + 页面真实点击兜底）
  - /chat    自动沟通（真正的浏览器操作：可见窗口真实点击「立即沟通」+ 真实键盘输入 + 发送 + 气泡确认）
  - /chat-watch 常驻「AI 跟聊」会话监听（单一常驻浏览器停在 BOSS 会话页：scan 会话列表 / open 切会话读记录 / send 回复）
  - /login   打开可见窗口扫码登录，Cookie 持久化到 ~/.bossclaw/camoufox-cookies.json

安全边界（与 Boss-claw AGENTS.md 一致）：
  - code 36/32 立即返回风险信号，绝不重试、绝不绕过
  - 只降低「正常操作被误判为机器人（code 37）」的概率，不绕过验证码 / 账户验证
  - 招呼语非空校验；发送间隔由渲染层限速器控制

协议：HTTP + token（默认 127.0.0.1:18767）
用法：python camoufox_server.py [--port 18767] [--token xxx]
"""

import argparse
import json
import os
import random
import re
import sys
import time
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from contextlib import contextmanager
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

# ===== 平台公共基座（浏览器 / 人类化 / Cookie 按平台持久化）=====
# BOSS 之外的平台（猎聘/智联/51Job）在 platforms/ 包内实现，复用本基座
from platforms.common import (
    log, human_delay, human_sleep, type_greeting_human,
    open_browser, goto_stable, load_cookies, save_cookies, clear_cookies,
    cookie_file, detect_kernel, PLATFORMS,
)
import platforms as platform_mods

# ============================================================
# BOSS 直聘专用风控文案与外部网申检测（聊天投递链路用）
# ============================================================
VERSION = '2.2.0'


# ============================================================
# 搜索（对齐 search_camoufox.py：joblist API + code 37 自动处理）
# ============================================================
def search_jobs(query: str, city: str, pages: int = 1, os_name: str | None = None) -> dict:
    log('🔍', f'搜索：{query} / city={city} / pages={pages}')
    all_jobs = []
    last_code = None
    last_msg = ''

    with open_browser(os_name=os_name) as page:
        cookies = load_cookies()
        for page_num in range(1, pages + 1):
            try:
                if cookies:
                    try:
                        page.context.add_cookies(cookies)
                    except Exception as e:
                        log('⚠️', f'注入 Cookie 失败：{e}')

                url = f"https://www.zhipin.com/web/geek/job?query={query}&city={city}&page={page_num}"
                log('📄', f'Page {page_num}: {url}')

                # BOSS 页面有持续轮询脚本（warlock/patas 心跳），networkidle 不可靠 → domcontentloaded
                resp = page.goto(url, wait_until="domcontentloaded", timeout=30000)
                # 等待页面稳定：跳过可能的 JS challenge / 安全检查跳转（参考 SKILL.md：
                # evaluate 时若页面仍在导航会抛 Execution context was destroyed，需等稳定后重试）
                human_sleep(4.5, 0.35, 2.5)
                try:
                    page.wait_for_function("() => document.body && document.body.innerText.length > 0", timeout=15000)
                except Exception:
                    pass
                human_sleep(0.8, 0.4, 0.4)
                current_url = page.url
                log('🔗', f'URL: {current_url[:110]} (status={resp.status if resp else "?"})')

                if "security-check" in current_url:
                    log('⚠️', '触发安全检查页，等待自动处理…')
                    human_sleep(7.5, 0.3, 5.0)
                    current_url = page.url
                    if "security-check" in current_url:
                        log('❌', '仍停留在安全检查页')
                        last_code, last_msg = 37, 'security-check 未自动通过'
                        break
                if "verify" in current_url:
                    log('❌', '命中验证页（需人工）')
                    last_code, last_msg = 35, 'verify page'
                    break
                if "403" in current_url:
                    log('❌', '403 禁止访问')
                    last_code, last_msg = 403, '403 forbidden'
                    break

                # 调用岗位列表 API（DOM 是 canvas 渲染，无法抓取）。
                # evaluate 可能因页面持续导航抛 Execution context destroyed，重试最多 3 次。
                # B2（转义正确性）：query/city 走 evaluate 参数传参 + encodeURIComponent，禁止 f-string 拼 JS。
                api_result = None
                for attempt in range(3):
                    try:
                        api_result = page.evaluate(
                            "({q, c, p}) => fetch('/wapi/zpgeek/search/joblist.json?scene=1&query=' + encodeURIComponent(q) + '&city=' + encodeURIComponent(c) + '&page=' + p + '&pageSize=30').then(r => r.json()).catch(e => ({error: e.message}))",
                            {"q": query, "c": city, "p": page_num},
                        )
                        break
                    except Exception as e:
                        log('⚠️', f'evaluate 第 {attempt + 1} 次失败：{str(e)[:60]}，等待 2s 重试…')
                        time.sleep(2)
                if api_result is None:
                    log('❌', 'API evaluate 重试耗尽')
                    break
                code = api_result.get('code')
                msg = api_result.get('message', '')
                log('🧾', f'API code={code} msg={msg[:40]}')
                last_code, last_msg = code, msg

                if code == 0:
                    jobs = api_result.get('zpData', {}).get('jobList', [])
                    log('✅', f'Page {page_num}: {len(jobs)} 个岗位')
                    all_jobs.extend(jobs)
                elif code == 37:
                    # 环境检查：自动访问 security-check 生成 zp_stoken 后重试一次
                    zp = api_result.get('zpData', {})
                    seed, name, ts = zp.get('seed', ''), zp.get('name', ''), zp.get('ts', '')
                    if seed and name:
                        sec_url = (f"https://www.zhipin.com/web/common/security-check.html"
                                   f"?seed={seed}&name={name}&ts={ts}"
                                   f"&callbackUrl=%2Fweb%2Fgeek%2Fjob%3Fquery%3D{query}%26city%3D{city}%26page%3D{page_num}")
                        page.goto(sec_url, wait_until="domcontentloaded", timeout=20000)
                        time.sleep(8)
                        if "security-check" not in page.url:
                            retry = page.evaluate(
                                "({q, c, p}) => fetch('/wapi/zpgeek/search/joblist.json?scene=1&query=' + encodeURIComponent(q) + '&city=' + encodeURIComponent(c) + '&page=' + p + '&pageSize=30').then(r => r.json())",
                                {"q": query, "c": city, "p": page_num},
                            )
                            if retry.get('code') == 0:
                                jobs = retry.get('zpData', {}).get('jobList', [])
                                log('✅', f'zp_stoken 后重试：{len(jobs)} 个岗位')
                                all_jobs.extend(jobs)
                                last_code = 0
                            else:
                                log('❌', f'重试失败：code={retry.get("code")}')
                                last_code, last_msg = retry.get('code'), retry.get('message', '')
                        else:
                            log('❌', 'security-check 未通过')
                    else:
                        log('❌', '缺少 seed/name/ts，无法自动处理')
                        last_code, last_msg = 37, 'missing seed/name/ts'
                elif code in (36, 32):
                    log('🚫', f'Code {code}：{msg} — 立即停止')
                    break
                elif code in (35, 37, 38):
                    # 35 需人工验证 / 37 环境检查 / 38 环境异常未登录 —— 透传给渲染层分类处理
                    log('⚠️', f'Code {code}：{msg} — 透传渲染层')
                    break
                elif code == 1006:
                    log('⏳', 'Code 1006 限速，等待 10s…')
                    time.sleep(10)
                elif code == 17:
                    log('⚠️', 'Code 17 未登录，搜索受限')
                    break
                else:
                    log('❌', f'Code {code}: {msg}')
                    break
            except Exception as e:
                log('❌', f'搜索异常：{e}')
                break
            if page_num < pages:
                delay = 3 + (page_num % 3)
                log('⏳', f'等待 {delay}s 再取下一页…')
                human_sleep(delay, 0.4, 1.5)

    # 保存会话 Cookie（登录态可能已在访问中刷新）
    try:
        # context 已随 with 关闭，Cookie 由后续 login/send 保存；此处仅记录
        pass
    except Exception:
        pass

    # 失败码收口：仅「显式成功」（code=0，或整批一页未跑且无失败码）才算成功。
    # 未列入已知风险码的码值一律 fail-safe 上报（对齐 platforms.ts::collectFaultScope 的未知码口径：
    # 命中 queue → 整批中止交人工；403 等归属 PLATFORM_FAULT_CODES → 平台级，其余平台继续）。
    if last_code not in (0, None):
        return {"ok": False, "code": last_code, "message": last_msg or f'采集失败（code {last_code}）', "jobs": []}

    formatted = format_jobs(all_jobs)
    log('🎉', f'搜索完成：共 {len(formatted)} 个岗位')
    return {"ok": True, "code": 0, "jobs": formatted}


def _fmt_publish_time(raw) -> str:
    """把 BOSS 的发布时间字段归一成前端 priority.ts::freshnessPriority 能判级的文本。

    只做格式归一，不做业务猜测；无法解析一律返回 ''（与「未识别」同义，不参与排序加权）。
    兼容 BOSS joblist 的 lastModifyTime（毫秒时间戳）/ lastModifyTimeStr（文本）/ publishTime。
    """
    s = str(raw or '').strip()
    if not s:
        return ''
    # 已是文本形态（如「3日内更新」「今天」）→ 原样返回，交给前端正则判级
    if not s.isdigit():
        return s[:40]
    try:
        ms = int(s)
        # 秒级时间戳兼容（10 位视为秒，13 位视为毫秒）
        ts = ms / 1000.0 if ms > 10 ** 11 else float(ms)
        delta = datetime.now() - datetime.fromtimestamp(ts)
        days = delta.days
        if days < 0:
            return ''
        if days == 0:
            return '今日更新'
        if days == 1:
            return '1天前更新'
        return f'{days}天前更新'
    except Exception:
        return ''


def format_jobs(raw_jobs: list) -> list:
    """BOSS 原始岗位字段 → Boss-claw JobMeta 兼容结构。"""
    output = []
    for j in raw_jobs:
        job_id = j.get('encryptJobId') or j.get('jobId')
        if not job_id:
            continue
        output.append({
            "jobId": job_id,
            "title": j.get('jobName', ''),
            "company": j.get('brandName', ''),
            "salary": j.get('salaryDesc', ''),
            "location": f"{j.get('cityName', '')} {j.get('areaDistrict', '')}".strip(),
            "experience": j.get('jobExperience', ''),
            "degree": j.get('jobDegree', ''),
            "labels": j.get('jobLabels', []),
            "skills": j.get('skills', []),
            # 福利/工作制度标签（如「周末双休」）：日薪折算月薪的工作日基数识别来源
            "welfare": j.get('welfareList', []),
            # 岗位发布时间（僵尸岗位过滤 + 新鲜度排序的唯一数据源）。
            # 此前该字段从未透传 → TS 侧 publishTime 恒为空，priority.ts 的 freshnessPriority
            # 永远返回 0，新鲜度维度实际失效。这里统一转成前端能判级的文本。
            "publishTime": _fmt_publish_time(j.get('lastModifyTime') or j.get('lastModifyTimeStr') or j.get('publishTime')),
            "description": j.get('jobDesc', ''),
            "recruiterName": j.get('bossName', ''),
            "bossTitle": j.get('bossTitle', ''),
            "companySize": j.get('scaleName', ''),
            "companyType": j.get('typeName', ''),
            "url": f"https://www.zhipin.com/job_detail/{job_id}.html",
        })
    return output


# ============================================================
# 发送（对齐 send_camoufox.py + send_v2.py 的双通道策略）
# ============================================================
def send_greeting(job_id: str, greeting: str, os_name: str | None = None, send_resume_image: bool = False) -> dict:
    greeting = str(greeting or '').strip()
    if not greeting:
        return {"ok": False, "code": 400, "message": "招呼语为空，拒绝发送", "sent": False}
    # P6-06：前端权威长度口径见 greetings.ts::GREETING_MAX_CHARS（200）与 GREETING_LENGTH_RULE；
    # 此处 800 仅为服务端防御上限（拦截异常超长输入），不承担「内容长度规范」职责。
    if len(greeting) > 800:
        return {"ok": False, "code": 400, "message": "招呼语过长（>800 字），拒绝发送", "sent": False}

    log('📨', f'发送招呼语 → job={job_id}（{len(greeting)} 字）')

    with open_browser(os_name=os_name) as page:
        cookies = load_cookies()
        if cookies:
            try:
                page.context.add_cookies(cookies)
                log('🍪', f'注入 {len(cookies)} 条 Cookie')
            except Exception as e:
                log('⚠️', f'注入 Cookie 失败：{e}')

        # Step 1: 访问搜索页建立会话（触发 zp_stoken / 环境检查）
        page.goto("https://www.zhipin.com/web/geek/job?query=Python&city=101010100&page=1",
                  wait_until="domcontentloaded", timeout=30000)
        human_sleep(2.8, 0.3, 1.5)
        if "security-check" in page.url:
            log('⚠️', '会话页触发安全检查，等待…')
            human_sleep(7.5, 0.3, 5.0)
        if "verify" in page.url:
            log('🚫', '命中验证页，需人工')
            return {"ok": False, "code": 35, "message": "需要人工安全验证", "sent": False}

        # Step 2: 登录态检测（页面 DOM 判断 + card API 探测）
        login_ok = False
        try:
            check = page.evaluate("""
                () => !!document.querySelector('.nav-resume-box') ||
                      !!document.querySelector('[ka*="resume"]') ||
                      document.body.innerText.includes('在线简历')
            """)
            login_ok = bool(check)
        except Exception:
            login_ok = False
        if not login_ok:
            log('🔑', '未检测到登录态，尝试 card API 验证…')
            try:
                card = page.evaluate(
                    "({jid}) => fetch('/wapi/zpgeek/job/card.json?encryptJobId=' + encodeURIComponent(jid), {credentials: 'include', headers: {'X-Requested-With': 'XMLHttpRequest'}}).then(r => r.json()).catch(e => ({error: e.message}))",
                    {"jid": job_id},
                )
                if card.get('code') in (0,):
                    login_ok = True
                elif card.get('code') == 17:
                    login_ok = False
            except Exception:
                pass
        if not login_ok:
            log('🚫', '未登录：请先在设置页执行「Camoufox 扫码登录」')
            return {"ok": False, "code": 31, "message": "未登录 BOSS（Camoufox 会话），请先扫码登录", "sent": False}

        # Step 3: 获取 encryptUserId（friend/add.json 需要）
        encrypt_user_id = ''
        job_info = {}
        try:
            card = page.evaluate(
                "({jid}) => fetch('/wapi/zpgeek/job/card.json?encryptJobId=' + encodeURIComponent(jid), {credentials: 'include', headers: {'X-Requested-With': 'XMLHttpRequest'}}).then(r => r.json()).catch(e => ({error: e.message}))",
                {"jid": job_id},
            )
            if card.get('code') == 0:
                zp = card.get('zpData', {})
                encrypt_user_id = zp.get('encryptUserId', '') or ''
                job_info = {
                    "jobName": zp.get('jobName', ''), "brandName": zp.get('brandName', ''),
                    "bossName": zp.get('bossName', ''), "bossTitle": zp.get('bossTitle', ''),
                }
                log('👤', f"目标：{job_info.get('jobName')} @ {job_info.get('brandName')}（{job_info.get('bossName')}）")
        except Exception as e:
            log('⚠️', f'card API 失败：{e}')

        # Step 4: 优先走 friend/add.json API（返回 code 0 = 成功）
        if encrypt_user_id:
            try:
                body = json.dumps({
                    "encryptJobId": job_id,
                    "encryptBossId": encrypt_user_id,
                    "greeting": greeting,
                }, ensure_ascii=False)
                send_result = page.evaluate(f"""
                    () => fetch('/wapi/zpgeek/friend/add.json', {{
                        method: 'POST',
                        headers: {{'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest'}},
                        body: JSON.stringify({json.dumps({
                            "encryptJobId": job_id,
                            "encryptBossId": encrypt_user_id,
                            "greeting": greeting,
                        }, ensure_ascii=False)})
                    }}).then(r => r.json()).catch(e => ({{error: e.message}}))
                """)
                code = send_result.get('code')
                log('🧾', f'friend/add.json code={code} msg={send_result.get("message", "")[:40]}')
                if code == 0:
                    save_cookies(page.context)
                    log('✅', '消息发送成功（API）')
                    return {"ok": True, "code": 0, "sent": True, "method": "api"}
                if code in (36, 32):
                    save_cookies(page.context)
                    return {"ok": False, "code": code, "message": send_result.get('message', ''), "sent": False}
                if code == 17:
                    save_cookies(page.context)
                    return {"ok": False, "code": 31, "message": "登录已失效，请重新扫码登录", "sent": False}
                if code == 37:
                    # 环境检查：走 security-check 后再试一次（对齐搜索逻辑）
                    log('⚠️', 'code 37 环境检查，尝试自动处理…')
                    zp = send_result.get('zpData', {})
                    seed, name, ts = zp.get('seed', ''), zp.get('name', ''), zp.get('ts', '')
                    if seed and name:
                        sec_url = (f"https://www.zhipin.com/web/common/security-check.html"
                                   f"?seed={seed}&name={name}&ts={ts}&callbackUrl=%2Fweb%2Fgeek%2Fjob")
                        page.goto(sec_url, wait_until="domcontentloaded", timeout=20000)
                        human_sleep(7.5, 0.3, 5.0)
                        if "security-check" not in page.url:
                            retry = page.evaluate(f"""
                                () => fetch('/wapi/zpgeek/friend/add.json', {{
                                    method: 'POST',
                                    headers: {{'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest'}},
                                    body: JSON.stringify({json.dumps({
                                        "encryptJobId": job_id,
                                        "encryptBossId": encrypt_user_id,
                                        "greeting": greeting,
                                    }, ensure_ascii=False)})
                                }}).then(r => r.json()).catch(e => ({{error: e.message}}))
                            """)
                            if retry.get('code') == 0:
                                save_cookies(page.context)
                                log('✅', '消息发送成功（API 重试）')
                                return {"ok": True, "code": 0, "sent": True, "method": "api"}
                            log('❌', f'API 重试失败：code={retry.get("code")}')
                            save_cookies(page.context)
                            if retry.get('code') in (36, 32):
                                return {"ok": False, "code": retry.get('code'), "message": retry.get('message', ''), "sent": False}
                log('⚠️', f'API 未成功（code={code}），尝试页面点击兜底…')
            except Exception as e:
                log('⚠️', f'API 发送异常：{e}')

        # Step 5: 页面点击「立即沟通」兜底（真实鼠标，最可靠）
        try:
            page.goto(f"https://www.zhipin.com/job_detail/{job_id}.html",
                      wait_until="domcontentloaded", timeout=30000)
            human_sleep(4.5, 0.35, 2.5)
            state = page.evaluate("""
                () => {
                    const all = Array.from(document.querySelectorAll('*'));
                    const liji = all.filter(el => el.textContent.trim() === '立即沟通');
                    const jixu = all.filter(el => el.textContent.trim() === '继续沟通');
                    return {state: jixu.length ? '继续沟通' : (liji.length ? '立即沟通' : 'not_found')};
                }
            """)
            log('🖱️', f'按钮状态：{state["state"]}')
            if state['state'] == '继续沟通':
                save_cookies(page.context)
                # P13（对齐 /chat 气泡确认、AGENTS 2.1）：到此仅为「已建立会话」，API 发送已失败，
                # 招呼语**文字气泡未确认**，不得计成功 → 返回非成功，交由 /chat 气泡确认路径处理。
                log('⚠️', '已建立会话但招呼语气泡未确认（API 发送未成功），不计成功')
                return {"ok": False, "code": 500, "message": "已建立会话但招呼语气泡未确认（API 发送未成功），请走自动沟通或人工补充", "sent": False}
            if state['state'] == 'not_found':
                save_cookies(page.context)
                return {"ok": False, "code": 404, "message": "未找到沟通按钮（可能岗位已下架）", "sent": False}
            page.locator("text=立即沟通").first.click(timeout=5000)
            human_sleep(4.5, 0.35, 2.5)
            final_state = page.evaluate("""
                () => {
                    const all = Array.from(document.querySelectorAll('*'));
                    const liji = all.filter(el => el.textContent.trim() === '立即沟通');
                    const jixu = all.filter(el => el.textContent.trim() === '继续沟通');
                    return {state: jixu.length ? '继续沟通' : (liji.length ? '立即沟通' : 'not_found')};
                }
            """)
            save_cookies(page.context)
            if final_state['state'] == '继续沟通':
                # P13：同样未确认招呼语气泡，不计成功
                log('⚠️', '已通过页面点击建立会话，但招呼语气泡未确认，不计成功')
                return {"ok": False, "code": 500, "message": "已建立会话但招呼语气泡未确认，请走自动沟通或人工补充招呼语", "sent": False}
            return {"ok": False, "code": 500, "message": "点击「立即沟通」后状态未变化", "sent": False}
        except Exception as e:
            save_cookies(page.context)
            return {"ok": False, "code": 500, "message": f"页面点击兜底失败：{e}", "sent": False}


# ============================================================
# 自动沟通（对齐 AI-BossJob-plus HRInteractionManager 沟通链 + webview.cjs openChatOnly）
# ============================================================
# 真正的浏览器操作：打开**可见**浏览器窗口 → 岗位详情 → 真实点击「立即沟通 / 继续沟通」
# → 真实键盘输入招呼语（isTrusted:true）→ 点击发送 / 回车 → 气泡确认 → 可选发送在线简历。
# 对齐点（来自 AI-BossJob-plus「觅星小臣 - BOSS海投助手」沟通模块）：
#   1. 输入框稳定选择器 `#chat-input`（contenteditable），找不到再回退 contenteditable/textarea；
#   2. 发送按钮优先 `.btn-send`（不要求文本含「发送」），回退按文本/class 匹配，再回退回车；
#   3. 发送确认 = 「自己消息气泡计数」为主（`.chat-message .im-list` 内 `li.message-item.item-self` 等），
#      文字匹配兜底 —— 未确认不计成功（JobClaw Safety invariant）；
#   4. 点击「立即沟通」后 BOSS 会弹「已开始沟通」确认框（handleGreetingModal：点「留在此页」/
#      dialogConfirmButton：确认/继续沟通），等待期间自动点掉；
#   5. 风控检测 = body innerText 正则（checkAndPauseOnRisk：安全验证/验证码/访问过于频繁…），
#      命中立即返回 risk，交人工，绝不自动重试。
# 安全不变量与 /send 一致：招呼语非空；code 35/36/32 立即停止交人工；不绕过验证码/账户验证。
CHAT_LABEL_RE = r'立即\s*沟通|继续\s*沟通|打个\s*招呼|打\s*招呼|聊\s*一\s*聊|去\s*沟通|开始\s*沟通'
RISK_TEXT_RE = re.compile(
    r'安全验证|访问过于频繁|请完成验证|验证码|异常请求|账号异常|操作过于频繁|请稍后再试|'
    r'登录已过期|请重新登录|当前环境异常|系统检测到异常'
)
# 点击「立即沟通」后的确认弹窗按钮文本（对齐 AI-BossJob-plus handleGreetingModal「留在此页」+ webview dialogConfirmButton）
MODAL_CONFIRM_RE = re.compile(
    r'^(继续沟通|确认沟通|去沟通|确定|确认|我知道了|继续|留在此页|留在本页|开启沟通)$'
)
# 招呼语最小长度（对齐 job-claw-main sendGreeting：< 8 字直接拒绝发送）
GREETING_MIN_LEN = 8
# 外部网申岗位检测（对齐 job-claw-main externalApplicationInfo：识别网申按钮，这类岗位跳过，不能自动沟通）
EXTERNAL_APPLY_RE = re.compile(
    r'立即\s*网申|去\s*网申|前往\s*网申|立即\s*申请|去\s*申请|申请\s*职位|立即\s*投递|投递\s*简历|前往\s*申请'
)


def _all_pages(page):
    """主页面 + 所有弹出/新开页面（点击「立即沟通」后聊天可能以新标签/新窗口打开）。"""
    pages = [page]
    try:
        for p in list(page.context.pages or []):
            if p not in pages:
                pages.append(p)
    except Exception:
        pass
    return pages


def _chat_button_state(page) -> str:
    """定位沟通按钮文本：继续沟通 / 立即沟通 / not_found。
    对齐 AI-BossJob-plus（a.op-btn-chat / 文本匹配）与 webview.cjs（正则 + 取最短文本的叶子元素）。"""
    try:
        return page.evaluate("""
            () => {
                const all = Array.from(document.querySelectorAll('button, a, [role="button"], span, div, i'));
                const text = (el) => (el.textContent || '').trim().replace(/\\s+/g, ' ');
                const visible = (el) => {
                    try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
                    catch (e) { return false; }
                };
                const re = /立即\\s*沟通|继续\\s*沟通|打个\\s*招呼|去\\s*沟通|开始\\s*沟通/;
                const hits = all.filter(el =>
                    visible(el) && text(el).length <= 12 && re.test(text(el)) &&
                    !(el.closest('[class*="dialog"],[class*="modal"]') || el.matches('[class*="dialog"] *,[class*="modal"] *'))
                );
                if (!hits.length) return 'not_found';
                hits.sort((a, b) => text(a).length - text(b).length);
                const label = text(hits[0]);
                if (/继续\\s*沟通/.test(label)) return '继续沟通';
                if (/立即\\s*沟通/.test(label)) return '立即沟通';
                return 'other';
            }
        """)
    except Exception:
        return 'not_found'


def _click_chat_button(page, state_label: str) -> bool:
    """真实点击沟通按钮：JS 精确定位（最短文本的可见叶子元素）→ 打临时标记 → Playwright 原生 click。
    状态为 'other'（打招呼/去沟通/开始沟通等）时使用宽口径 CHAT_LABEL_RE 命中入口按钮。"""
    try:
        marker = 'data-bossclaw-chat-btn'
        # state 是完整词（继续沟通/立即沟通）；'other' 交给宽口径 CHAT_LABEL_RE（打招呼/去沟通/开始沟通…）
        js_pattern = CHAT_LABEL_RE if state_label == 'other' else re.sub(r'\s+', r'\\s*', state_label)
        ok = page.evaluate("""(pat, marker) => {
            const all = Array.from(document.querySelectorAll('button, a, [role="button"], span, div, i'));
            const text = (el) => (el.textContent || '').trim().replace(/\\s+/g, ' ');
            const visible = (el) => {
                try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
                catch (e) { return false; }
            };
            const re = new RegExp(pat);
            const hits = all.filter(el =>
                visible(el) && text(el).length <= 12 && re.test(text(el)) &&
                !(el.closest('[class*="dialog"],[class*="modal"]') || el.matches('[class*="dialog"] *,[class*="modal"] *'))
            );
            if (!hits.length) return false;
            hits.sort((a, b) => text(a).length - text(b).length);
            hits[0].setAttribute(marker, '1');
            return true;
        }""", js_pattern, marker)
        if not ok:
            return False
        page.locator(f'[{marker}]').first.click(timeout=8000)
        return True
    except Exception as e:
        log('⚠️', f'点击沟通按钮失败：{e}')
        return False


def _dismiss_chat_modal(page) -> bool:
    """点掉「已开始沟通」确认弹窗（AI-BossJob-plus handleGreetingModal：.default-btn.cancel-btn「留在此页」；
    webview dialogConfirmButton：确认/继续沟通/留在此页，只认弹窗容器或 BOSS 自家按钮）。"""
    try:
        return bool(page.evaluate("""() => {
            const re = /^(继续沟通|确认沟通|去沟通|确定|确认|我知道了|继续|留在此页|留在本页|开启沟通)$/;
            const all = Array.from(document.querySelectorAll('button, [role="button"], .default-btn, .btn-sure-v2, a'));
            for (const el of all) {
                const label = (el.textContent || '').trim();
                if (!re.test(label)) continue;
                if (!(el.offsetWidth || el.offsetHeight)) continue;
                const inDialog = Boolean(el.closest('[class*="dialog"],[class*="modal"],[class*="popover"],[class*="sentence-popover"]')) ||
                                 el.matches('.default-btn, .btn-sure-v2, [class*="dialog"] *,[class*="modal"] *');
                if (inDialog || label === '留在此页' || label === '留在本页') {
                    el.click();
                    return true;
                }
            }
            return false;
        }"""))
    except Exception:
        return False


def _risk_text_hit(page) -> str:
    """对齐 AI-BossJob-plus checkAndPauseOnRisk：body innerText 正则检测风控/验证页，命中返回命中词。"""
    try:
        text = page.evaluate("() => (document.body ? document.body.innerText.slice(0, 4000) : '')") or ''
        m = RISK_TEXT_RE.search(text)
        return m.group(0) if m else ''
    except Exception:
        return ''


def _find_chat_input(page):
    """定位聊天输入框：打分式候选（对齐 job-claw-main chatInput/chatInputScore）。
    优先 #chat-input / contenteditable / textarea / slate·lexical / role=textbox，
    排除搜索/筛选输入框，取分最高者；跨主页面与弹出聊天窗口查找。
    在页面内给最佳输入框打上 `data-bossclaw-chat-input` 标记，返回 Playwright Locator 或 None。"""
    js = r"""
    () => {
      const vas = (el) => {
        try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch (e) { return false; }
      };
      const editable = (el) => {
        if (!el || typeof el.matches !== 'function') return false;
        const tag = (el.tagName || '').toLowerCase();
        if (tag === 'textarea') return true;
        if (tag === 'input') {
          const t = (el.getAttribute('type') || 'text').toLowerCase();
          return ['text','search',''].includes(t);
        }
        const cm = (el.getAttribute('contenteditable') || '').toLowerCase();
        return el.isContentEditable || (cm && !['false','inherit','off'].includes(cm))
          || el.getAttribute('role') === 'textbox'
          || el.getAttribute('data-slate-editor') === 'true'
          || el.getAttribute('data-lexical-editor') === 'true';
      };
      const selectors = [
        '#chat-input', 'textarea#chat-input',
        '[contenteditable]:not([contenteditable="false"])',
        'textarea', 'input[type="text"]', 'input:not([type])',
        '[role="textbox"]', '[data-slate-editor="true"]', '[data-lexical-editor="true"]',
        '[class*="chat-input"]', '[class*="chatInput"]', '[class*="message-input"]', '[class*="messageInput"]'
      ];
      const seen = new Set();
      const cands = [];
      for (const sel of selectors) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          if (seen.has(el)) continue;
          seen.add(el);
          if (!editable(el) || !vas(el)) continue;
          if (el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true') continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 120 || rect.height < 18) continue;
          cands.push(el);
        }
      }
      if (!cands.length) return { found: false };
      const vw = window.innerWidth || 1400, vh = window.innerHeight || 900;
      let best = null, bestScore = -Infinity;
      for (const el of cands) {
        const rect = el.getBoundingClientRect();
        const ph = [el.getAttribute('placeholder')||'', el.getAttribute('data-placeholder')||'', el.getAttribute('aria-label')||''].join(' ');
        const sem = ph + ' ' + (el.id||'') + ' ' + (el.className||'');
        const tag = (el.tagName||'').toLowerCase();
        const cm = (el.getAttribute('contenteditable')||'').toLowerCase();
        const chatAnc = el.closest('[class*="chat"],[class*="message"],[class*="conversation"],[class*="dialog"],[role="dialog"]');
        const searchAnc = el.closest('[class*="search"],[class*="filter"],[class*="contact-search"]');
        let s = 0;
        if (el.id === 'chat-input') s += 600;
        if (tag === 'textarea') s += 240;
        if (el.isContentEditable || (cm && !['false','inherit','off'].includes(cm))) s += 220;
        if (cm === 'plaintext-only') s += 180;
        if (el.getAttribute('data-slate-editor')==='true' || el.getAttribute('data-lexical-editor')==='true') s += 200;
        if (el.getAttribute('role')==='textbox') s += 140;
        if (/按enter键发送|ctrl\+enter|请输入|输入消息|发送消息|沟通|消息|回复/i.test(sem)) s += 260;
        if (/chat[-_]?input|message[-_]?input|editor/i.test(sem)) s += 180;
        if (chatAnc) s += 180;
        if (rect.top > vh*0.52) s += 160;
        if (rect.left > vw*0.24) s += 120;
        if (rect.right > vw*0.55) s += 70;
        if (rect.width > 320) s += 60;
        if (searchAnc && !chatAnc && el.id !== 'chat-input') s -= 520;
        if (rect.top < vh*0.32 && el.id !== 'chat-input') s -= 280;
        if (rect.left < vw*0.22 && el.id !== 'chat-input') s -= 240;
        if (s > bestScore) { bestScore = s; best = el; }
      }
      if (!best) return { found: false };
      best.setAttribute('data-bossclaw-chat-input', '1');
      return { found: true, tag: (best.tagName||'').toLowerCase(), id: best.id || '' };
    }
    """
    pages = _all_pages(page)
    for p in pages:
        try:
            ok = p.evaluate(js)
            if ok and ok.get('found'):
                loc = p.locator('[data-bossclaw-chat-input]').first
                if loc.count() > 0:
                    return loc
        except Exception:
            continue
    return None


def _chat_input_selector():
    """聊天输入框统一候选选择器：优先打分标记，其次兜底常见 id/可编辑元素。"""
    return '[data-bossclaw-chat-input], #chat-input, [contenteditable="true"], ' \
           '[contenteditable="plaintext-only"], div[contenteditable], textarea'


def _input_text(page) -> str:
    """读取聊天输入框当前内容（校验输入是否成功）。"""
    try:
        return str(page.evaluate("""(sel) => {
            const input = document.querySelector(sel);
            if (!input) return '';
            if (input.isContentEditable) return input.innerText || input.textContent || '';
            return input.value || '';
        }""", _chat_input_selector()) or '')
    except Exception:
        return ''


def _inject_text_via_exec(page, greeting: str) -> bool:
    """兜底注入：execCommand('insertText')（AI-BossJob-plus sendCustomReply 同款，React 受控组件可感知）。"""
    try:
        sel = _chat_input_selector()
        ok = page.evaluate("""(sel, text) => {
            const input = document.querySelector(sel);
            if (!input) return false;
            input.focus();
            if (input.isContentEditable) {
                const sel = window.getSelection();
                if (sel && sel.selectAllChildren) {
                    sel.selectAllChildren(input);
                    document.execCommand('delete');
                }
                document.execCommand('insertText', false, text);
            } else {
                input.value = text;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return true;
        }""", sel, greeting)
        return bool(ok)
    except Exception:
        return False


def _count_own_messages(page) -> int:
    """自己消息气泡计数（对齐 AI-BossJob-plus countOwnMessages）：
    在 `.chat-message .im-list` 内按候选选择器计数；无法识别任何候选时返回 -1（表示不确定）。"""
    try:
        return int(page.evaluate("""() => {
            const container = document.querySelector('.chat-message .im-list, [class*="chat-message"] [class*="im-list"]');
            if (!container) return -1;
            const sels = ['li.message-item.item-self', 'li.message-item.item-me', 'li.message-item.me',
                          'li.message-item.item-own', '.chat-message .message-self', '.im-list li[class*="self"]',
                          '.im-list li[class*="item-me"]', '.im-list li[class*="own"]'];
            for (const s of sels) {
                const n = container.querySelectorAll(s).length;
                if (n > 0) return n;
            }
            return -1;
        }""") or -1)
    except Exception:
        return -1


def _confirm_bubble_count(page, before: int, timeout_ms: int = 8000) -> bool:
    """轮询确认新气泡出现（对齐 AI-BossJob-plus confirmMessageSent）：before 为发送前快照。
    before === -1（无法识别气泡选择器）时返回 False，交由文字匹配兜底。"""
    if before == -1:
        return False
    deadline = time.time() + timeout_ms / 1000.0
    while time.time() < deadline:
        now = _count_own_messages(page)
        if now != -1 and now > before:
            log('✅', f'气泡计数确认：{before} → {now}')
            return True
        time.sleep(0.4)
    return False


def _outgoing_message_fingerprints(page) -> set:
    """聊天记录中「自己发出」消息的指纹集合（对齐 job-claw-main chatMessageSnapshot /
    isOutgoingTranscriptNode 几何校验）：消息块中心在输入框中心 58% 右侧或右缘贴近输入框右缘 → 视为自己（右侧）消息;
    排除「您正在与BOSS…」「竞争者PK」等干扰文本。返回 {class|text|left|top} 之集合。"""
    try:
        res = page.evaluate("""() => {
            const input = document.querySelector('[data-bossclaw-chat-input]');
            const iRect = input ? input.getBoundingClientRect() : null;
            const selectors = ['.chat-message .im-list li', '.message-item', '.message-content',
              '[class*="message-item"]', '[class*="message-content"]', '[class*="bubble"]',
              '[class*="chat-message"]', '[class*="messageItem"]', '[data-message-id]'];
            const all = [];
            for (const sel of selectors) {
                for (const el of Array.from(document.querySelectorAll(sel))) if (!all.includes(el)) all.push(el);
            }
            const set = {};
            let count = 0;
            for (const el of all) {
                const t = (el.textContent || '').trim().replace(/[\\u200b-\\u200d\\ufeff\\u2060]/g, ' ').replace(/\\s+/g, ' ');
                if (t.length < 2 || t.length > 900) continue;
                const r = el.getBoundingClientRect();
                if (!r || r.width <= 0) continue;
                if (/您正在与BOSS.*沟通|竞争者PK|查看详细分析|超过\\d+位Boss新发布/.test(t)) continue;
                const cls = (el.className||'').toLowerCase() + ' ' + ((el.parentElement && el.parentElement.className)||'').toLowerCase();
                let outgoing = /item-self|item-me|item-myself|message-self|item-own|right/.test(cls);
                if (!outgoing && iRect) {
                    const cx = r.left + r.width / 2;
                    if (cx >= iRect.left + iRect.width * 0.58 || r.right >= iRect.right - Math.max(110, iRect.width * 0.12)) outgoing = true;
                }
                if (!outgoing) continue;
                const fp = (el.className||'') + '|' + t + '|' + Math.round(r.left) + '|' + Math.round(r.top);
                if (!set[fp]) { set[fp] = 1; count += 1; }
            }
            return Object.keys(set);
        }""")
        return set(res or [])
    except Exception:
        return set()


def _greeting_new_fps(page, greeting: str, before: set, timeout_ms: int = 30000) -> bool:
    """稳定气泡确认（对齐 job-claw-main waitForStableOutgoingGreeting）：
    在 `before` 快照之后出现「完整招呼语」对应的自己气泡，并**连续 3 次稳定指纹**才判定成功。
    未确认不计成功（AGENTS.md 2.1 安全不变量）。"""
    needle = ' '.join(str(greeting or '').replace('\u200b', '').replace('\ufeff', '').split())
    if not needle:
        return False
    started = time.time()
    deadline = started + timeout_ms / 1000.0
    stable = 0
    last = ''
    while time.time() < deadline:
        now = _outgoing_message_fingerprints(page)
        matched = []
        for fp in now:
            if fp in before:
                continue
            # 完整招呼语匹配（对齐 greetingMessageNodes：须匹配全文，而非公共前缀）。
            # fp = class|text|left|top，text 可能含 `|`，故从右侧取最后两段（left/top）。
            parts = fp.split('|')
            body = '|'.join(parts[1:-2]) if len(parts) >= 4 else fp
            body_norm = ' '.join(body.split())
            if body_norm == needle \
                    or (needle in body_norm and len(body_norm) <= len(needle) + 32) \
                    or (body_norm in needle and len(body_norm) >= len(needle) - 12):
                matched.append(fp)
        fingerprint = '||'.join(sorted(matched))
        if fingerprint and (time.time() - started >= 2.2):
            stable = stable + 1 if fingerprint == last else 1
            last = fingerprint
            if stable >= 3:
                log('✅', f'气泡稳定确认（指纹 ×3，命中 {len(matched)} 条）')
                return True
        else:
            stable = 0
            last = ''
        time.sleep(0.4)
    return False


def _confirm_message(page, greeting: str, before: set | None = None, timeout_ms: int = 30000) -> bool:
    """文字气泡确认（稳定指纹·完整招呼语匹配，安全不变量：未确认不计成功）。
    before 缺省时先对当前已发出消息做一次快照。"""
    try:
        before = before if before is not None else set()
        return _greeting_new_fps(page, greeting, before, timeout_ms)
    except Exception:
        return False


def _find_send_button(page, input_el=None):
    """定位发送按钮（对齐 job-claw-main sendButton 打分法）：
    仅取聊天输入区附近、语义为「发送」的按钮，排除「发送简历/发送附件/发简历/在线简历/图片」类按钮，
    避免误点附件类按钮。命中后打标记返回 Playwright Locator + kind。"""
    js = r"""
    () => {
      const vas = (el) => {
        try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch (e) { return false; }
      };
      const text = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ');
      let inputRect = null;
      const input = document.querySelector('[data-bossclaw-chat-input]');
      if (input) { try { inputRect = input.getBoundingClientRect(); } catch (e) {} }
      const selectors = ['button', '[role="button"]', '[class*="send-btn"]', '[class*="sendBtn"]',
        '[class*="send-message"]', '[class*="sendMessage"]', '[ka*="chat-send"]',
        '[ka*="send-message"]', '[aria-label*="发送"]'];
      const all = [];
      for (const sel of selectors) {
        for (const el of Array.from(document.querySelectorAll(sel))) if (!all.includes(el)) all.push(el);
      }
      let best = null, bestScore = -Infinity;
      for (const el of all) {
        if (!vas(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        const label = text(el);
        const sem = label + ' ' + (el.getAttribute('aria-label')||'') + ' ' + (el.getAttribute('ka')||'') + ' ' + (el.className||'');
        if (/发送简历|发送附件|发送在线简历|发简历|在线简历|图片/.test(sem)) continue;
        if (!/^发送$/.test(label) && !/(chat[-_]?send|send[-_]?message|sendbtn|send-btn|发送)/i.test(sem)) continue;
        const r = el.getBoundingClientRect();
        let s = /^发送$/.test(label) ? 180 : 0;
        if (/(chat[-_]?send|send[-_]?message|sendbtn|send-btn)/i.test(sem)) s += 90;
        if (inputRect) {
          const vd = Math.min(Math.abs(r.top - inputRect.bottom), Math.abs(r.bottom - inputRect.top));
          if (vd > 320 || r.left < inputRect.left - 120) continue;
          if (r.left >= inputRect.left + inputRect.width * 0.55) s += 70;
          if (r.top >= inputRect.top - 80 && r.top <= inputRect.bottom + 130) s += 70;
          s -= Math.min(160, Math.abs(r.top - inputRect.bottom) * 0.5);
        }
        if (s > bestScore) { bestScore = s; best = el; }
      }
      if (!best) return { found: false };
      best.setAttribute('data-bossclaw-send', '1');
      return { found: true, kind: (best.className && /send/i.test(best.className)) ? 'class-send' : 'send' };
    }
    """
    try:
        ok = page.evaluate(js)
        if ok and ok.get('found'):
            loc = page.locator('[data-bossclaw-send]').first
            if loc.count() > 0:
                return loc, ok.get('kind') or 'send'
    except Exception:
        pass
    return None, None


def _external_apply_hit(page) -> bool:
    """外部网申岗位检测（对齐 job-claw-main externalApplicationInfo）：
    详情页存在「立即网申/去网申/立即申请/申请职位…」按钮 → 该岗位需跳转网申，无法自动沟通，应跳过。"""
    try:
        return bool(page.evaluate("""() => {
            const text = (el) => (el.textContent || '').trim().replace(/\\s+/g, ' ');
            const vas = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch (e) { return false; } };
            const re = /立即\\s*网申|去\\s*网申|前往\\s*网申|立即\\s*申请|去\\s*申请|申请\\s*职位|立即\\s*投递|投递\\s*简历|前往\\s*申请/;
            const all = Array.from(document.querySelectorAll('button,a,[role="button"],span,div'));
            return all.some(el => vas(el) && !el.disabled && re.test(text(el)));
        }"""))
    except Exception:
        return False


def _norm_identity(v: str) -> str:
    """身份归一化（对齐 conversationIdentity.normalizeConversationIdentity 的精简版）。"""
    s = str(v or '')
    for w in ('有限责任公司', '股份有限公司', '有限公司', '招聘者', '招聘方', '人事行政', '人事', 'hr', '在线', '刚刚活跃', '活跃'):
        s = s.replace(w, '')
    return re.sub(r'[^\w\u4e00-\u9fff]', '', s).lower()


def _chat_header_identity(page) -> dict:
    """读取聊天页头目标 HR / 公司（对齐 AI-BossJob `_name-text` / `.name-box span:nth-child(2)` 与 job-claw header）。"""
    try:
        return page.evaluate("""() => {
            const clean = (t) => (t || '').trim();
            const recruiter = document.querySelector('.name-text, [class*="chat-title"] .name, [class*="friend-name"]');
            const companyEl = document.querySelector('.name-box span:nth-child(2), [class*="company-name"]');
            return { recruiter: clean(recruiter ? recruiter.textContent : ''),
                     company: clean(companyEl ? companyEl.textContent : '') };
        }""") or {}
    except Exception:
        return {}


def _resolve_target_conflict(expected: dict, actual: dict) -> bool:
    """目标 HR/会话明确冲突（对齐 job-claw-main conversationSelectionEvidence：companyConflict/jobConflict）。
    仅当期望与实见信息**都存在且不同**时才判冲突；信息缺失/截断时不武断阻断。"""
    exp_r = _norm_identity(expected.get('recruiterName'))
    act_r = _norm_identity(actual.get('recruiter'))
    exp_c = _norm_identity(expected.get('company'))
    act_c = _norm_identity(actual.get('company'))
    if exp_r and act_r:
        return exp_r != act_r          # HR 姓名双方都明确且不同 → 冲突
    if exp_c and act_c and len(exp_c) >= 2 and len(act_c) >= 2:
        return exp_c != act_c          # 仅公司可用，双方明确且不同 → 冲突
    return False


def _read_hr_friend_context(page) -> dict:
    """读取 HR 发来的消息与完整对话历史（对齐 AI-BossJob getLastFriendMessageText / hasHRResponded）。

    返回：
      - count：HR 侧消息条数（兼容旧判定）
      - last：最新一条**非系统提示**的 HR 消息文本（无则 ''）
      - history：双方最近消息（按时序，早→晚），元素 {fromHr, text, sys}，用于多轮 AI 跟聊
      - needs_reply：最后一条「非系统」消息是 HR 发的（= 在等我回复，对齐 ghost-job 的 unanswered()）
    无 HR 真实消息返回 {count:0, last:'', history:[], needs_reply:False}。"""
    try:
        r = page.evaluate("""() => {
            const c = document.querySelector('.chat-message .im-list, [class*="chat-message"] [class*="im-list"]');
            if (!c) return { count: 0, last: '', history: [] };
            const items = Array.from(c.querySelectorAll('li.message-item, li[class*="message-item"]'))
                .filter(el => el.getBoundingClientRect().width > 0);
            const clean = (s) => (s || '').replace(/[\\u200b-\\u200d\\ufeff\\u2060]/g, ' ').trim().replace(/\\s+/g, ' ').slice(0, 800);
            // BOSS 系统/提示类消息（打招呼确认、等待回复、简历被查看等）：不计入「真实消息」判定
            const sysRe = /已向(TA|.{1,6})打了招呼|等待对方回复|请耐心等待|BOSS推荐|简历已被查看|系统消息|非常抱歉|未读/;
            const history = [];
            let friendCount = 0;
            let last = '';
            for (const el of items) {
                const cls = el.className || '';
                const fromHr = el.classList.contains('item-friend') || /item-friend/.test(cls);
                const fromMe = el.classList.contains('item-myself') || /item-myself/.test(cls);
                if (!fromHr && !fromMe) continue;
                const t = el.querySelector('.text span, [class*="text"] span, [class*="content"]') || el;
                const s = clean(t ? t.textContent : '');
                if (!s) continue; // 纯系统卡片没有文字，跳过
                const sys = sysRe.test(s);
                history.push({ fromHr: !!fromHr, text: s, sys: sys });
                if (fromHr) {
                    friendCount += 1;
                    if (!sys) last = s;
                }
            }
            return { count: friendCount, last: last, history: history.slice(-30) };
        }""") or {}
        hist = r.get('history') or []
        # needs_reply：从末尾往前跳过系统提示，最后一条真实消息是谁发的（对齐 ghost-job unanswered()）
        needs = False
        for m in reversed(hist):
            if m.get('sys'):
                continue
            needs = bool(m.get('fromHr'))
            break
        return {
            'count': int(r.get('count') or 0),
            'last': str(r.get('last') or ''),
            'history': hist,
            'needs_reply': needs,
        }
    except Exception:
        return {'count': 0, 'last': '', 'history': [], 'needs_reply': False}


def _chat_button_link(page) -> str:
    """取沟通按钮的 a[href]（用于 app.zhipin.com 域名交接，对齐 job-claw enterChat）。"""
    try:
        return str(page.evaluate("""() => {
            const text = (el) => (el.textContent || '').trim().replace(/\\s+/g, ' ');
            const vas = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch (e) { return false; } };
            const re = /立即\\s*沟通|继续\\s*沟通|打招呼|去沟通|开始沟通/;
            const hits = Array.from(document.querySelectorAll('button,a,[role="button"],span,div,i'))
                .filter(el => vas(el) && text(el).length <= 12 && re.test(text(el)));
            if (!hits.length) return '';
            hits.sort((a, b) => text(a).length - text(b).length);
            const el = hits[0];
            const a = el.matches && el.matches('a') ? el : (el.closest && el.closest('a'));
            return (a && a.getAttribute('href')) || el.getAttribute('href') || '';
        }""") or '')
    except Exception:
        return ''


def _enter_chat(page, timeout: int = 28):
    """健壮进入沟通页面（对齐 job-claw-main enterChat / waitForChatReady）：
    1) 轮询聊天输入框；2) 自动点掉「已开始沟通」弹窗；3) 未就绪则真实点击/重点「立即沟通·继续沟通」；
    4) app.zhipin.com 域名交接（同标签导航）。返回 (target_page, input_locator)；失败返回 (None, error_dict)。"""
    deadline = time.time() + timeout
    last_click_at = 0
    clicks = 0
    no_btn = 0
    while time.time() < deadline:
        # 1) 输入框已就绪 → 命中
        for p in _all_pages(page):
            risk = _risk_text_hit(p)
            if risk:
                return None, {"code": 35, "message": f"检测到安全验证/访问受限（{risk}），已暂停，请人工完成验证"}
            try:
                _dismiss_chat_modal(p)
            except Exception:
                pass
            inp = _find_chat_input(p)
            if inp is not None:
                return p, inp
        # 2) 外部网申岗位 → 跳过
        if _external_apply_hit(page):
            return None, {"code": 600, "external": True, "message": "该岗位为外部网申，无法在 BOSS 聊天中自动沟通，跳过"}
        # 3) 找沟通按钮并点击（限频重试，避免狂点）
        state = _chat_button_state(page)
        if state == 'not_found':
            no_btn += 1
            if no_btn >= 4:
                return None, {"code": 404, "message": "未找到沟通按钮（岗位可能已下架或页面未加载）"}
        else:
            no_btn = 0
            href = _chat_button_link(page)
            # app.zhipin.com 域名交接：同标签导航（对齐 enterChat 移除 target=_blank 后 location.href）
            if href and re.search(r'//app\.zhipin\.com/(?:%23/)?/(?:web/)?geek/chat', href):
                try:
                    page.goto(href, wait_until="domcontentloaded", timeout=20000)
                    human_sleep(2.6, 0.3, 1.5)
                    continue
                except Exception:
                    pass
            if time.time() - last_click_at > 1.5:
                last_click_at = time.time()
                clicks += 1
                clicked = _click_chat_button(page, state)
                if not clicked:
                    try:
                        page.locator(f"text={state}").first.click(timeout=3000)
                        clicked = True
                    except Exception:
                        pass
                if clicked:
                    log('🖱️', f'已真实点击「{state}」，等待沟通窗口…')
                    # 点击后随机等待弹窗/聊天窗口出现
                    human_sleep(1.1, 0.35, 0.5)
                    continue
        # 轮询帧内随机间隔，接近真人观感，避免机械节拍
        human_sleep(0.55, 0.4, 0.25)
    return None, {"code": 500, "message": "未找到聊天输入框（沟通窗口可能未打开、需继续沟通多次或被验证拦截）"}


def _open_resume_entry(page) -> bool:
    """点击聊天工具栏的「简历/附件」入口，打开 upload-select-dialog（对齐 chat-new v5543 聊天页源码）：
    聊天输入区工具栏点击简历入口会弹出 upload-select-dialog（选择「上传简历 / 发送在线简历」）。
    定位策略：ka/aria/class 语义命中（resume/jianli/附件）优先，其次输入区附近的附加类图标按钮兜底。"""
    js = r"""
    () => {
      const vas = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch (e) { return false; } };
      const text = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ');
      // 仅在聊天页操作（避免误点击岗位详情页头部「简历」导航菜单）
      if (!document.querySelector('[data-bossclaw-chat-input],[class*="chat-conversation"],[class*="chat-message"],#chat-input,[contenteditable="true"]')) return false;
      const input = document.querySelector('[data-bossclaw-chat-input]');
      let iRect = null;
      if (input) { try { iRect = input.getBoundingClientRect(); } catch (e) {} }
      const sems = ['resume', 'jianli', 'attachment', 'attach', 'send-resume', 'add-resume'];
      const candidates = [];
      for (const el of Array.from(document.querySelectorAll('button,[role="button"],a,span,div,i'))) {
        if (!vas(el)) continue;
        if (el.closest('[class*="dialog"],[class*="modal"],[class*="popover"]')) continue;
        const hit = ((el.getAttribute('ka') || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.className || '')).toLowerCase();
        if (!sems.some((s) => hit.includes(s))) continue;
        if (iRect) {
          const r = el.getBoundingClientRect();
          // 排除页面头部「简历」导航（登录态菜单）等远离输入区的元素，只认聊天输入区附近的简历入口
          if (r.top < iRect.top - 140 || r.top > iRect.bottom + 180) continue;
          if (r.left < iRect.left - 220) continue;
        }
        candidates.push(el);
      }
      if (candidates.length) {
        candidates.sort((a, b) => text(b).length - text(a).length);
        candidates[0].click();
        return true;
      }
      // 兜底：输入区附近带附加类外观（加号/更多/工具）的图标按钮（排除表情/发送）
      if (iRect) {
        const extra = Array.from(document.querySelectorAll('button,[role="button"],[class*="add"],[class*="more"],[class*="tool"],[class*="icon"]'))
          .filter((el) => {
            if (!vas(el)) return false;
            if (el.closest('[class*="dialog"],[class*="modal"],[class*="popover"]')) return false;
            const r = el.getBoundingClientRect();
            if (r.top < iRect.top - 140 || r.top > iRect.bottom + 180) return false;
            if (r.left < iRect.left - 220) return false;
            if (text(el).trim().length > 0) return false;
            const sem = (el.className || '').toLowerCase();
            if (/send|emoji|face|expression/i.test(sem)) return false;
            return true;
          });
        if (extra.length) {
          // 图标按钮取最靠近输入框右缘的一个（工具栏右侧一般为附加类入口）
          extra.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
          extra[0].click();
          return true;
        }
      }
      return false;
    }
    """
    try:
        return bool(page.evaluate(js))
    except Exception:
        return False


def _click_select_dialog_option(page, keyword: str) -> bool:
    """在 upload-select-dialog 的选项块中点击含 keyword 的一项（上传简历 / 发送在线简历）。"""
    try:
        return bool(page.evaluate("""(kw) => {
            const dlg = document.querySelector('.upload-select-dialog, [class*="upload-select"]');
            if (!dlg) return false;
            const opt = Array.from(dlg.querySelectorAll('.select-one, [class*="select-one"], li, div,a,button'))
                .find((el) => (el.offsetWidth || el.offsetHeight) &&
                    (el.textContent || '').trim().replace(/\\s+/g, '').includes(kw));
            if (!opt) return false;
            opt.click();
            return true;
        }""", keyword))
    except Exception:
        return False


def _fill_upload_resume_files(page, files: list) -> bool:
    """在 upload-resume-dialog 中选择附件简历文件（input[ka=user-resume-upload-file]，接收 jpg/png/doc/pdf），
    注入后由 BOSS 自动上传并发送（对齐聊天页源码：`您的附件简历 X 已发送给Boss点击查看附件`）。"""
    try:
        finput = page.locator(
            '.upload-resume-dialog input[type="file"], input[type="file"][ka*="resume"], input[type="file"]'
        ).first
        finput.set_input_files(files=files)
        human_sleep(3.2, 0.3, 1.8)
        return True
    except Exception as e:
        log('⚠️', f'附件简历文件注入失败：{e}')
        return False


def _upload_resume_images(page, resume_images: list) -> dict:
    """发送图片简历（对齐 chat-new v5543 流程：简历入口 → upload-select-dialog →「上传简历」→ 注入文件自动发送；
    保留旧版「直接命中发送简历/附件按钮」路径为兜底链）。图片为可选项：失败不阻断已确认的文字沟通。"""
    if not resume_images:
        return {"ok": True, "skipped": True}
    import base64
    files = []
    for ri in resume_images[:4]:
        data = str(ri.get('data') or '')
        if not data.startswith('data:'):
            continue
        mime = (re.match(r'data:([^;,]+)', data).group(1) if re.match(r'data:([^;,]+)', data) else 'image/png')
        _, _, b64 = data.partition(',')
        try:
            buf = base64.b64decode(b64)
        except Exception:
            continue
        if not buf:
            continue
        files.append({'name': str(ri.get('name') or 'resume.png'), 'mimeType': mime, 'buffer': buf})
    if not files:
        return {"ok": False, "error": "图片简历数据为空"}
    try:
        # 新流程：聊天工具栏简历入口 → 上传简历 → 注入文件（BOSS 自动上传发送）
        if _open_resume_entry(page):
            human_sleep(0.9, 0.4, 0.4)
            if _click_select_dialog_option(page, '上传简历'):
                human_sleep(0.9, 0.4, 0.4)
                if _fill_upload_resume_files(page, files):
                    log('📄', f'已按新聊天页流程注入 {len(files)} 张图片简历，等待自动发送')
                    return {"ok": True}
        # 旧流程兜底：直接点「发送简历/附件/图片」入口 + 任意可见文件框注入
        try:
            page.evaluate("""() => {
                const vas = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch (e) { return false; } };
                const text = (el) => (el.textContent || '').trim().replace(/\\s+/g, ' ');
                const btns = Array.from(document.querySelectorAll('button,[role="button"],a,span,div,[class*="attach"],[class*="img"]'))
                    .filter(el => vas(el) && !el.closest('[class*="dialog"]') && /发送简历|图片|附件/.test((el.className || '') + ' ' + text(el)));
                btns.sort((a, b) => text(b).length - text(a).length);
                if (btns.length) btns[0].click();
            }""")
        except Exception:
            pass
        human_sleep(0.9, 0.4, 0.4)
        finput = page.locator('input[type="file"]').first
        finput.set_input_files(files=files)
        human_sleep(2.6, 0.3, 1.5)
        log('📄', f'已注入 {len(files)} 张图片简历，等待上传完成')
        return {"ok": True}
    except Exception as e:
        log('⚠️', f'图片简历上传失败（忽略）：{e}')
        return {"ok": False, "error": str(e)}


def _send_chat_text(target_page, text: str) -> dict:
    """在「当前已打开的聊天窗口」里真实输入并发送文本，确认我方气泡后返回结果。

    发送前快照 → 类人逐字输入（空则 execCommand 兜底）→ 点发送/回车 → 稳定指纹 ×3 完整文本确认。
    发送失败或未确认一律不计成功（AGENTS.md 2.1 安全不变量）。首次招呼语与 AI 跟聊回复共用。
    返回 {ok:True, sentVia} 或 {ok:False, code, message}。
    """
    # 输入框就绪（重新打分标记：常驻会话页切换会话后输入框可能重建）
    input_el = _find_chat_input(target_page)
    if input_el is None:
        return {"ok": False, "code": 500, "message": "未找到聊天输入框"}
    before_fps = _outgoing_message_fingerprints(target_page)
    try:
        input_el.click()
        # 点击后短暂停顿，模拟真人移动鼠标/停留
        human_sleep(0.4, 0.5)
        target_page.keyboard.press('ControlOrMeta+a')
        target_page.keyboard.press('Delete')
        # 逐字随机打字节奏（接近真人，替代固定 delay=25）
        type_greeting_human(target_page, text)
        human_sleep(0.5, 0.4)
        typed = _input_text(target_page)
        if not typed.strip() or len(typed.strip()) < 5:
            log('⚠️', '键盘输入后内容为空，execCommand 兜底注入…')
            _inject_text_via_exec(target_page, text)
            human_sleep(0.4, 0.5)
        log('⌨️', '沟通文本已真实输入')
    except Exception as e:
        return {"ok": False, "code": 500, "message": f"输入沟通文本失败：{e}"}

    sent_via = 'enter'
    send_btn, send_kind = _find_send_button(target_page)
    if send_btn is not None:
        # 发送前随机停顿，模拟真人看完输入内容后点击
        human_sleep(0.5, 0.5, 0.2)
        try:
            send_btn.click()
            sent_via = send_kind or 'button'
            log('🖱️', f'已点击发送按钮（{sent_via}）')
        except Exception:
            try:
                target_page.keyboard.press('Enter')
                sent_via = 'enter'
                log('⌨️', '发送按钮点击失败，已回车发送')
            except Exception:
                pass
    else:
        try:
            target_page.keyboard.press('Enter')
            log('⌨️', '已回车发送')
        except Exception:
            pass
    # 发送后随机停留，等气泡出现主体再确认（对齐 waitForStableOutgoingGreeting 的稳定期）
    human_sleep(1.8, 0.4, 0.8)

    confirmed = _confirm_message(target_page, text, before_fps)
    if not confirmed:
        human_sleep(2.6, 0.3, 1.5)
        confirmed = _confirm_message(target_page, text, before_fps)
    if not confirmed:
        return {"ok": False, "code": 501, "message": "未能确认文字气泡已发送，请人工核对"}
    log('✅', f'文字气泡确认（发送方式：{sent_via}）')
    return {"ok": True, "sentVia": sent_via}


def chat_greeting(job_id: str, greeting: str, os_name: str | None = None,
                  send_resume_image: bool = False, send_online_resume: bool = False,
                  expected: dict | None = None, resume_images: list | None = None,
                  mode: str = 'auto', reply_text: str | None = None,
                  attachment_delay_seconds: float = 4.0) -> dict:
    # mode: 'auto' 首次打招呼投递（若 HR 已发来消息则转「AI 跟聊」返回 700）；
    #       'reply' 发送渲染层生成的 AI 回复文本（对齐 AI-BossJob aiReply 链路）；
    #       'check' 只读巡检：打开会话但不发送，仅回传 HR 历史供渲染层生成 AI 跟聊（长驻监听用）。
    if mode == 'check':
        send_text = ''
        scope_label = 'AI 跟聊巡检'
    elif mode == 'reply':
        send_text = str(reply_text or greeting or '').strip()
        scope_label = 'AI 回复'
    else:
        send_text = str(greeting or '').strip()
        scope_label = '打招呼'
    if mode != 'check':
        if not send_text:
            return {"ok": False, "code": 400, "message": "沟通文本为空，拒绝发送", "sent": False}
        if len(send_text) > 800:
            return {"ok": False, "code": 400, "message": "沟通文本过长（>800 字），拒绝发送", "sent": False}
        if len(send_text) < GREETING_MIN_LEN:
            return {"ok": False, "code": 400, "message": f"沟通文本过短（<{GREETING_MIN_LEN} 字），拒绝发送", "sent": False}

    log('💬', f'自动沟通（{scope_label}）→ job={job_id}（{len(send_text)} 字，可见窗口）')

    # 可见窗口：真正的浏览器操作，用户可全程观看
    with open_browser(os_name=os_name, headless=False) as page:
        cookies = load_cookies()
        if cookies:
            try:
                page.context.add_cookies(cookies)
                log('🍪', f'注入 {len(cookies)} 条 Cookie')
            except Exception as e:
                log('⚠️', f'注入 Cookie 失败：{e}')

        # Step 1: 建立会话（触发 zp_stoken / 环境检查）
        page.goto("https://www.zhipin.com/web/geek/job?query=Python&city=101010100&page=1",
                  wait_until="domcontentloaded", timeout=30000)
        human_sleep(2.8, 0.3, 1.5)
        if "verify" in page.url:
            return {"ok": False, "code": 35, "message": "需要人工安全验证", "sent": False}
        if "security-check" in page.url:
            log('⚠️', '会话页触发安全检查，等待…')
            human_sleep(7.5, 0.3, 5.0)
        risk = _risk_text_hit(page)
        if risk:
            return {"ok": False, "code": 35, "message": f"检测到安全验证/访问受限（{risk}），已暂停，请人工完成验证", "sent": False}

        # Step 2: 登录态检测（页面 DOM + card API 探测）
        login_ok = False
        try:
            check = page.evaluate("""
                () => !!document.querySelector('.nav-resume-box') ||
                      !!document.querySelector('[ka*="resume"]') ||
                      document.body.innerText.includes('在线简历')
            """)
            login_ok = bool(check)
        except Exception:
            login_ok = False
        if not login_ok:
            try:
                card = page.evaluate(
                    "({jid}) => fetch('/wapi/zpgeek/job/card.json?encryptJobId=' + encodeURIComponent(jid), {credentials: 'include', headers: {'X-Requested-With': 'XMLHttpRequest'}}).then(r => r.json()).catch(e => ({error: e.message}))",
                    {"jid": job_id},
                )
                if card.get('code') == 0:
                    login_ok = True
            except Exception:
                pass
        if not login_ok:
            log('🚫', '未登录：请先在「自动沟通」页执行扫码登录')
            return {"ok": False, "code": 31, "message": "未登录 BOSS，请先扫码登录", "sent": False}

        # Step 3: 打开岗位详情页
        page.goto(f"https://www.zhipin.com/job_detail/{job_id}.html",
                  wait_until="domcontentloaded", timeout=30000)
        # 打开岗位页后随机停留，模拟真人阅读岗位内容再继续
        human_sleep(4.5, 0.35, 2.5)
        if "verify" in page.url:
            return {"ok": False, "code": 35, "message": "需要人工安全验证", "sent": False}
        risk = _risk_text_hit(page)
        if risk:
            return {"ok": False, "code": 35, "message": f"检测到安全验证/访问受限（{risk}），已暂停，请人工完成验证", "sent": False}
        # 外部网申岗位 → 跳过（对齐 job-claw externalApplicationInfo；配合优先级 -6000）
        if _external_apply_hit(page):
            save_cookies(page.context)
            return {"ok": False, "code": 600, "external": True,
                    "message": "该岗位为外部网申，无法在 BOSS 聊天中自动沟通，已跳过", "sent": False}

        # Step 4-5: 健壮进入沟通页面（点击按钮/重点「继续沟通」/ app.zhipin 交接 / 弹窗确认），取回聊天输入框
        target_page, input_el = _enter_chat(page)
        # 修复：_enter_chat 失败时返回 (None, error_dict)，input_el 是 dict 而非 None。
        # 旧代码只判 input_el is None，漏检后把 dict 当元素句柄 .click()，崩出
        # "'dict' object has no attribute 'click'"。此处必须按 target_page 判失败，
        # 并对 dict 做双保险，同时把错误码（35 风控 / 600 外部网申 / 404 无按钮）透传出去。
        if target_page is None or input_el is None or isinstance(input_el, dict):
            save_cookies(page.context)
            err = input_el if isinstance(input_el, dict) else {}
            return {"ok": False, "code": err.get('code', 500), "sent": False,
                    "message": err.get('message', '沟通窗口未打开'),
                    "external": bool(err.get('external'))}

        try:
            target_page.bring_to_front()
        except Exception:
            pass

        # Step 5.5: 目标 HR/会话核验（对齐 AGENTS.md 2.1「目标 HR 或会话明确冲突时：不发送」/
        # job-claw conversationSelectionEvidence）；信息缺失或截断时不武断阻断。
        if expected and (expected.get('recruiterName') or expected.get('company')):
            actual = _chat_header_identity(target_page)
            if _resolve_target_conflict(expected, actual):
                save_cookies(page.context)
                return {"ok": False, "code": 602, "conflict": True, "sent": False,
                        "message": f"目标疑似冲突：期望 HR={expected.get('recruiterName') or '?'}/公司={expected.get('company') or '?'}，"
                                   f"实见 HR={actual.get('recruiter') or '?'}/公司={actual.get('company') or '?'}，已暂停发送"}

        # Step 5.6: 只读巡检（mode='check'）——不发送任何消息，仅回传 HR 最新消息与完整对话历史，
        # 供渲染层「AI 跟聊监听」生成多轮回复后走 mode='reply' 发送。
        if mode == 'check':
            hr_ctx = _read_hr_friend_context(target_page)
            save_cookies(page.context)
            return {"ok": True, "code": 0, "checked": True, "sent": False,
                    "needsReply": bool(hr_ctx.get('needs_reply')),
                    "hasHrMessage": hr_ctx.get('count', 0) > 0,
                    "hrLastMessage": hr_ctx.get('last', ''),
                    "hrHistory": hr_ctx.get('history') or [],
                    "message": "巡检完成（未发送）"}

        # Step 5.7: 判断会话状态（对齐 ghost-job unanswered()）：
        #   - 最后一条真实消息是 HR 发的 → 返回 700，进入「AI 跟聊」回复（不发送打招呼语）；
        #   - 已建立会话但最后一条是我方发的（无需回复）→ 返回 701，跳过重复打招呼；
        #   - 尚无任何会话 → 继续正常发送打招呼语。
        # 注意：不能用「HR 曾发过消息」当回复条件，否则我方已回复过的会话会被重复回复。
        if mode != 'reply':
            hr_ctx = _read_hr_friend_context(target_page)
            if hr_ctx.get('count', 0) > 0:
                if hr_ctx.get('needs_reply') and hr_ctx.get('last'):
                    save_cookies(page.context)
                    return {"ok": False, "code": 700, "needsReply": True, "hasHrMessage": True,
                            "hrLastMessage": hr_ctx.get('last', ''),
                            "hrHistory": hr_ctx.get('history') or [],
                            "message": "HR 已发来消息，进入 AI 跟聊回复", "sent": False}
                save_cookies(page.context)
                return {"ok": False, "code": 701, "alreadyChatted": True, "sent": False,
                        "hrHistory": hr_ctx.get('history') or [],
                        "message": "已与该 HR 建立会话且无需回复，跳过重复打招呼"}

        # Step 6-9: 真实输入并发送（发送前快照 → 类人逐字输入 → 发送 → 稳定气泡确认）
        send_res = _send_chat_text(target_page, send_text)
        if not send_res.get('ok'):
            save_cookies(page.context)
            return {"ok": False, "code": send_res.get('code', 500),
                    "message": send_res.get('message', '发送失败'), "sent": False}
        sent_via = send_res.get('sentVia') or 'enter'

        # Step 10: 可选 —— 在线简历 / 图片简历（对齐 chat-new v5543 流程：
        # 聊天工具栏「简历」入口 → upload-select-dialog →「上传简历 / 发送在线简历」）。
        # 设置约束：附件延迟（attachmentDelaySeconds，秒）作为「文字沟通确认 → 发送简历附件」的
        # 类人等待基准：只有配置值 > 0 才额外等待（base=配置值，保留 ±0.35 抖动、±30% min），
        # 配置为 0 时保持旧行为（不额外等待）；内容上传内部的人类化停顿不受影响。
        if (send_online_resume or (send_resume_image and resume_images)) and float(attachment_delay_seconds or 0) > 0:
            human_sleep(float(attachment_delay_seconds), 0.35, float(attachment_delay_seconds) * 0.3)
        if send_online_resume:
            try:
                online_sent = False
                for p in _all_pages(page):
                    # 新流程：简历入口 → upload-select-dialog →「发送在线简历」
                    if _open_resume_entry(p):
                        human_sleep(0.9, 0.4, 0.4)
                        if _click_select_dialog_option(p, '发送在线简历'):
                            human_sleep(2.2, 0.3, 1.2)
                            log('📄', '已通过「发送在线简历」发送在线简历')
                            online_sent = True
                            break
                    # 旧流程兜底：页面存在直达「发送在线简历」按钮（含已打开的弹窗选项）
                    try:
                        online_btn = p.locator("text=发送在线简历").first
                        if online_btn.is_visible(timeout=1500):
                            online_btn.click()
                            human_sleep(1.3, 0.3, 0.6)
                            log('📄', '已点击「发送在线简历」')
                            online_sent = True
                            break
                    except Exception:
                        continue
                if not online_sent:
                    log('⚠️', '未找到「发送在线简历」入口（忽略）')
            except Exception:
                log('⚠️', '发送在线简历失败（忽略）')
        if send_resume_image and resume_images:
            _upload_resume_images(target_page, resume_images)

        save_cookies(page.context)
        return {"ok": True, "code": 0, "sent": True, "method": "browser-chat", "sentVia": sent_via}


# ============================================================
# 扫码登录（打开可见窗口，等待用户扫码）——goto_stable 已移至 platforms/common.py
# ============================================================
def do_login(timeout: int = 180, os_name: str | None = None) -> dict:
    log('🔐', '打开登录窗口，请用手机 BOSS App 扫码')
    with open_browser(os_name=os_name, headless=False) as page:
        cookies = load_cookies()
        if cookies:
            try:
                page.context.add_cookies(cookies)
            except Exception:
                pass
        if not goto_stable(page, "https://www.zhipin.com/web/user/?ka=header-login"):
            return {"ok": False, "code": 35,
                    "message": "BOSS 未能加载出登录页（可能被反爬拦截），请重试或改用「内置浏览器」登录"}
        log('🔗', f'登录页 URL：{page.url[:120]}')

        start = time.time()
        last_count = 0
        while time.time() - start < timeout:
            current = (page.url or '').strip().lower()
            # 1) 忽略非法/空白页（about:blank、data: 等新开页初始 URL），避免误判成功
            if not current or not current.startswith('http'):
                time.sleep(2)
                continue
            # 2) 关键判断：仅当 URL 是真实 zhipin 页面、已离开登录/用户页、且不在安全验证页才算成功
            is_zhipin = 'zhipin.com' in current
            challenge = 'security-check' in current or 'verify' in current
            still_login = '/user/' in current or 'login' in current
            if is_zhipin and not still_login and not challenge:
                # 已跳离登录页（登录成功后 BOSS 会跳到工作台/首页）
                log('✅', f'URL 已跳转：{current[:80]}')
                save_cookies(page.context)
                return {"ok": True, "loggedIn": True}
            # 3) 仍在登录页等待扫码：只统计 cookie 变化，不做任何成功判定
            try:
                cookies_now = page.context.cookies()
                if len(cookies_now) != last_count:
                    last_count = len(cookies_now)
                    log('👀', f'等待扫码中…（cookies: {last_count}）')
            except Exception:
                pass
            time.sleep(2)

        log('❌', '登录超时')
        return {"ok": False, "code": 31, "message": "扫码登录超时，请重试"}


# ============================================================
# 常驻「AI 跟聊」会话监听（单一常驻浏览器停在 BOSS 会话页）
# ============================================================
# 对齐觅星小臣 / ghost-job 的做法：不逐岗位重开浏览器，而是常驻一个会话页，
#   ① scan  读会话列表（接口优先 / DOM 兜底），筛出「HR 发了最后一条」的会话；
#   ② open  点击列表项切到目标会话，用 getBossData 响应 / 窗口头部双重校验身份，回传完整聊天记录；
#   ③ send  发送前再校验一次窗口身份，再真实输入 + 稳定气泡确认（防串人）。
# Playwright sync 对象有线程亲和性 → 所有浏览器操作都投递到**单线程执行器**里跑，
# HTTP 处理线程只负责提交命令并等待结果。
CHAT_WATCH_URL = 'https://www.zhipin.com/web/geek/chat'
CHAT_WATCH_ACTIONS = ('start', 'scan', 'open', 'send', 'stop', 'status')

_chat_watch_cm = None      # 常驻 open_browser 上下文（懒创建，stop 时 __exit__）
_chat_watch_page = None    # 常驻会话页
_chat_watch_lock = threading.RLock()
_chat_watch_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='bossclaw-chat-watch')

# 伪会话（BOSS 智能聊天 / 系统消息等）：不是真人 HR，必须排除
PSEUDO_CONV_RE = re.compile(
    r'Boss智能聊天|BOSS智能聊天|智能聊天|智能对话|智能助手|求职助手|简历助手|'
    r'系统消息|官方账号|AI筛选|^AI$|^系统$'
)

# 读会话列表：接口优先（geekFilterByLabel + getGeekFriendList），DOM 兜底/并集
_JS_SCAN_CONV = """
async () => {
  const norm = (s) => (s || '').replace(/[\\u200b-\\u200d\\ufeff\\u2060]/g, '').replace(/\\s+/g, ' ').trim();
  const out = [];
  const seen = new Set();
  const push = (o) => { if (o.name && !seen.has(o.name)) { seen.add(o.name); out.push(o); } };

  // ① 接口：先按更新时间取会话 id，再批量取详情（详情里才有 uid / lastMessageInfo）
  try {
    const r1 = await fetch('/wapi/zprelation/friend/geekFilterByLabel?labelId=0', { credentials: 'include' })
      .then((r) => r.json()).catch(() => null);
    if (r1 && r1.code === 0) {
      const ids = ((r1.zpData && r1.zpData.friendList) || []).slice(0, 30)
        .map((f) => f.friendId).filter(Boolean);
      if (ids.length) {
        const r2 = await fetch('/wapi/zprelation/friend/getGeekFriendList.json', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'friendIds=' + encodeURIComponent(ids.join(',')),
          credentials: 'include',
        }).then((r) => r.json()).catch(() => null);
        const list = (r2 && r2.code === 0 && r2.zpData && (r2.zpData.result || r2.zpData.friendList)) || [];
        for (const f of list) {
          const lm = f.lastMessageInfo || {};
          push({
            name: norm(f.name || f.bossName || ''),
            company: norm(f.brandName || f.company || ''),
            jobName: norm(f.jobName || (f.job && f.job.jobName) || ''),
            preview: norm(lm.text || lm.message || ''),
            unread: Number(f.unreadCount || f.unreadMsgCount || 0) > 0 || !!lm.unread,
            friendId: String(f.friendId || ''),
            uid: String(f.uid || ''),
            lastFromId: String(lm.fromId || ''),
            dom: false,
          });
        }
      }
    }
  } catch (e) { /* 接口不可用 → 走 DOM */ }

  // ② DOM 兜底/并集：接口没覆盖到的会话补上（含未读标记与预览）
  try {
    const raw = document.querySelectorAll(
      'ul[role="group"] li[role="listitem"], .user-list-content li, .user-list li, .chat-user li, ' +
      '.friend-list li, [class*="user-list"] li, [class*="friend-list"] li, [class*="chat-list"] li, ' +
      '[class*="user-item"], [class*="conversation-item"]'
    );
    const FILTER_LABEL = /^(全部|未读|新招呼|沟通过|已投递|已交换|牛人|新消息|我的|推荐|筛选|更多|置顶|收藏|不合适|已结束|打招呼|AI筛选|AI筛选提交|AI助手|智能助手)$/;
    for (const li of Array.from(raw)) {
      if (li.querySelectorAll('li').length || !li.querySelector('img')) continue;
      const whole = norm(li.textContent);
      if (whole.length < 2 || FILTER_LABEL.test(whole.replace(/\\s+/g, ''))) continue;
      const nameEl = li.querySelector('[class*="name"], [class*="title"], [class*="geek-name"]');
      const lines = norm(li.innerText || li.textContent || '').split(' ').filter(Boolean);
      let name = norm(nameEl ? nameEl.textContent : '');
      if (!name) {
        name = lines.find((t) => t.length >= 2 && t.length <= 12 &&
          !/公司|科技|集团|有限|刚|活跃|在线|已读|未读|回复|您好|你好/.test(t)) || '';
      }
      if (!name || seen.has(name)) continue;
      const unread = !!li.querySelector('[class*="unread"], [class*="badge"], sup');
      const preview = lines.length ? lines[lines.length - 1] : '';
      push({ name, company: '', jobName: '', preview, unread, friendId: '', uid: '', lastFromId: '', dom: true });
    }
  } catch (e) { /* 忽略 */ }
  return out;
}
"""

# 在左侧列表里定位并标记目标会话项（返回坐标，供 Playwright / mouse 点击）
_JS_MARK_CONV = """
(arg) => {
  const norm = (s) => (s || '').replace(/[\\u200b-\\u200d\\ufeff\\u2060]/g, '').replace(/\\s+/g, ' ').trim();
  const target = norm(arg && arg.name);
  const cTarget = norm(arg && arg.company);
  const raw = Array.from(document.querySelectorAll(
    'ul[role="group"] li[role="listitem"], .user-list-content li, .user-list li, .chat-user li, ' +
    '.friend-list li, [class*="user-list"] li, [class*="friend-list"] li, [class*="chat-list"] li, ' +
    '[class*="user-item"], [class*="conversation-item"]'
  )).filter((li) => !li.querySelectorAll('li').length && li.querySelector('img'));
  document.querySelectorAll('[data-bossclaw-conv]').forEach((el) => el.removeAttribute('data-bossclaw-conv'));
  let exact = null, loose = null;
  for (const li of raw) {
    const t = norm(li.textContent);
    if (!t) continue;
    const nameEl = li.querySelector('[class*="name"], [class*="title"], [class*="geek-name"]');
    const n = norm(nameEl ? nameEl.textContent : '');
    if (n && n === target) { exact = li; break; }
    if (!loose && t.includes(target) && (!cTarget || t.includes(cTarget))) loose = li;
  }
  const hit = exact || loose;
  if (!hit) return { found: false };
  hit.setAttribute('data-bossclaw-conv', '1');
  try { hit.scrollIntoView({ block: 'center' }); } catch (e) { /* 忽略 */ }
  const r = hit.getBoundingClientRect();
  return { found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
           text: norm(hit.textContent).slice(0, 60) };
}
"""


def _same_identity(a: str, b: str) -> bool:
    """两个身份串是否视为同一人（复用 _norm_identity 的归一化口径）。"""
    na, nb = _norm_identity(a), _norm_identity(b)
    if not na or not nb:
        return False
    return na == nb or na in nb or nb in na


def _boss_data_name(api: dict | None) -> str:
    """从 getBossData 响应里取 HR 姓名（= ghost-job 的 zpData.data.name）。"""
    try:
        zp = (api or {}).get('zpData') or api or {}
        data = zp.get('data') or {}
        return str(data.get('name') or zp.get('hrName') or '').strip()
    except Exception:
        return ''


def _boss_data_job(api: dict | None) -> str:
    """从 getBossData 响应里取岗位名。"""
    try:
        zp = (api or {}).get('zpData') or api or {}
        job = zp.get('job') or {}
        data = zp.get('data') or {}
        return str(job.get('jobName') or data.get('jobName') or zp.get('jobName') or '').strip()
    except Exception:
        return ''


def _chat_page_ready(page) -> bool:
    """会话页是否已渲染（登录后才有会话列表 / 输入框）。"""
    try:
        return bool(page.evaluate("""() => !!(document.querySelector(
            '#chat-input,[data-bossclaw-chat-input],[class*="im-list"],[class*="user-list"],'
            + '[class*="chat-conversation"],[class*="geek-chat"],[class*="friend-list"]'
        ))"""))
    except Exception:
        return False


def _open_conversation(page, name: str, company: str = '') -> dict:
    """点击左侧列表项切到目标会话，并双重校验身份后回传完整聊天记录（防串人）。"""
    name = str(name or '').strip()
    if not name:
        return {"ok": False, "code": 400, "message": "缺少会话名"}
    info = page.evaluate(_JS_MARK_CONV, {"name": name, "company": company})
    if not info or not info.get('found'):
        return {"ok": False, "code": 404, "message": f"左侧列表未找到会话「{name}」（可能未渲染或已折叠）"}

    api = None
    api_name = ''
    try:
        with page.expect_response(lambda r: 'getBossData' in r.url, timeout=6000) as ri:
            try:
                page.locator('[data-bossclaw-conv]').first.click(timeout=5000)
            except Exception:
                page.mouse.click(info.get('x', 0), info.get('y', 0))
        try:
            api = ri.value.json()
            api_name = _boss_data_name(api)
        except Exception:
            api = None
    except Exception:
        # 无 getBossData（命中缓存等）→ 坐标点击 + 头部校验兜底
        try:
            page.mouse.click(info.get('x', 0), info.get('y', 0))
        except Exception:
            pass

    # 接口明确报的是别人 → 立刻放弃（绝不放行，防串人）
    if api_name and not _same_identity(api_name, name):
        return {"ok": False, "code": 602,
                "message": f"点击后打开的会话是「{api_name}」，与目标「{name}」不符，已放弃（防串人）"}

    human_sleep(1.0, 0.4, 0.5)
    header = {}
    deadline = time.time() + 6
    while time.time() < deadline:
        header = _chat_header_identity(page)
        cur = str(header.get('recruiter') or '')
        if cur and _same_identity(cur, name):
            break
        human_sleep(0.6, 0.3, 0.3)

    hr_ctx = _read_hr_friend_context(page)
    cur_name = str((header or {}).get('recruiter') or '')
    if cur_name and not _same_identity(cur_name, name) and not (api_name and _same_identity(api_name, name)):
        return {"ok": False, "code": 602,
                "message": f"当前窗口是「{cur_name}」，与目标「{name}」不符，已放弃（防串人）"}
    if not hr_ctx.get('history'):
        return {"ok": False, "code": 500, "message": f"「{name}」会话内暂无可读消息（会话可能为空或未切换成功）"}
    return {
        "ok": True,
        "name": name,
        "company": str((header or {}).get('company') or company or ''),
        "jobName": _boss_data_job(api),
        "history": hr_ctx.get('history') or [],
        "needsReply": bool(hr_ctx.get('needs_reply')),
        "hrLastMessage": hr_ctx.get('last', ''),
        "matchedBy": 'api' if api_name else ('header' if cur_name else 'content'),
    }


def _send_to_conversation(page, name: str, company: str = '', text: str = '') -> dict:
    """发送前再校验一次窗口身份，然后真实输入并发送（防串人 + 未确认不计成功）。"""
    text = str(text or '').strip()
    if not text:
        return {"ok": False, "code": 400, "message": "回复文本为空，拒绝发送", "sent": False}
    if len(text) > 800:
        return {"ok": False, "code": 400, "message": "回复文本过长（>800 字），拒绝发送", "sent": False}
    if len(text) < GREETING_MIN_LEN:
        return {"ok": False, "code": 400, "message": f"回复文本过短（<{GREETING_MIN_LEN} 字），拒绝发送", "sent": False}
    header = _chat_header_identity(page)
    cur = str((header or {}).get('recruiter') or '')
    if cur and name and not _same_identity(cur, name):
        return {"ok": False, "code": 602, "sent": False,
                "message": f"发送前校验失败：当前窗口是「{cur}」，与目标「{name}」不符，放弃发送（防串人）"}
    res = _send_chat_text(page, text)
    if not res.get('ok'):
        return {"ok": False, "code": res.get('code', 500), "sent": False,
                "message": res.get('message', '发送失败')}
    return {"ok": True, "sent": True, "method": "browser-chat-watch", "sentVia": res.get('sentVia')}


def _watch_teardown() -> None:
    """关闭常驻会话浏览器（幂等；必须在执行器线程内调用以保证线程亲和）。"""
    global _chat_watch_cm, _chat_watch_page
    cm = _chat_watch_cm
    _chat_watch_cm, _chat_watch_page = None, None
    if cm is not None:
        try:
            cm.__exit__(None, None, None)
        except Exception as e:
            log('⚠️', f'关闭会话监听浏览器失败：{e}')


def _watch_start(os_name: str | None = None) -> dict:
    _watch_teardown()
    cm = open_browser(os_name=os_name, headless=False)
    page = cm.__enter__()
    global _chat_watch_cm, _chat_watch_page
    _chat_watch_cm, _chat_watch_page = cm, page
    cookies = load_cookies()
    if cookies:
        try:
            page.context.add_cookies(cookies)
        except Exception as e:
            log('⚠️', f'注入 Cookie 失败：{e}')
    page.goto(CHAT_WATCH_URL, wait_until="domcontentloaded", timeout=30000)
    human_sleep(3.4, 0.35, 2.0)
    if 'login' in (page.url or '').lower():
        return {"ok": False, "code": 31, "message": "未登录 BOSS，请先扫码登录"}
    risk = _risk_text_hit(page)
    if risk:
        return {"ok": False, "code": 35, "message": f"检测到安全验证/访问受限（{risk}），请人工完成验证"}
    if not _chat_page_ready(page):
        human_sleep(3.0, 0.3, 2.0)
    if not _chat_page_ready(page):
        return {"ok": False, "code": 500, "message": "会话页未就绪（可能未登录或页面结构已变化）"}
    save_cookies(page.context)
    log('👂', '常驻会话监听已启动（BOSS 会话页）')
    return {"ok": True, "ready": True}


def _watch_scan() -> dict:
    if _chat_watch_page is None:
        return {"ok": False, "code": 400, "message": "会话监听未启动"}
    page = _chat_watch_page
    risk = _risk_text_hit(page)
    if risk:
        return {"ok": False, "code": 35, "message": f"检测到安全验证/访问受限（{risk}）"}
    try:
        items = page.evaluate(_JS_SCAN_CONV) or []
    except Exception as e:
        return {"ok": False, "code": 500, "message": f"读取会话列表失败：{e}"}
    # 过滤伪会话（BOSS 智能聊天 / 系统消息等）
    convs = [c for c in items if not PSEUDO_CONV_RE.search(str(c.get('name') or '').replace(' ', ''))]
    return {"ok": True, "conversations": convs, "total": len(items)}


def _watch_open(name: str, company: str) -> dict:
    if _chat_watch_page is None:
        return {"ok": False, "code": 400, "message": "会话监听未启动"}
    return _open_conversation(_chat_watch_page, name, company)


def _watch_send(name: str, company: str, text: str) -> dict:
    if _chat_watch_page is None:
        return {"ok": False, "code": 400, "message": "会话监听未启动"}
    return _send_to_conversation(_chat_watch_page, name, company, text)


def _watch_stop() -> dict:
    _watch_teardown()
    log('🛑', '常驻会话监听已停止')
    return {"ok": True, "running": False}


def _watch_dispatch(cmd: str, payload: dict) -> dict:
    """所有会话监听命令都在执行器线程内串行执行（保证 Playwright 线程亲和）。"""
    with _chat_watch_lock:
        if cmd == 'start':
            return _watch_start(payload.get('os'))
        if cmd == 'scan':
            return _watch_scan()
        if cmd == 'open':
            return _watch_open(payload.get('name', ''), payload.get('company', ''))
        if cmd == 'send':
            return _watch_send(payload.get('name', ''), payload.get('company', ''), payload.get('text', ''))
        if cmd == 'stop':
            return _watch_stop()
        if cmd == 'status':
            return {"ok": True, "running": _chat_watch_page is not None,
                    "url": (_chat_watch_page.url if _chat_watch_page is not None else '')}
        return {"ok": False, "error": f"unknown chat-watch cmd: {cmd}"}


def chat_watch_command(cmd: str, payload: dict, timeout: float = 90.0) -> dict:
    """把会话监听命令投递到单线程执行器并等待结果（HTTP 处理线程不直接碰浏览器）。"""
    try:
        fut = _chat_watch_executor.submit(_watch_dispatch, cmd, payload or {})
        return fut.result(timeout=timeout)
    except FutureTimeoutError:
        log('❌', f'会话监听命令超时：{cmd}')
        return {"ok": False, "error": f"会话监听命令超时（{cmd}）"}
    except Exception as e:
        log('❌', f'会话监听命令异常：{cmd} / {e}')
        try:
            _chat_watch_executor.submit(_watch_teardown)
        except Exception:
            pass
        return {"ok": False, "error": str(e)}


# ============================================================
# HTTP 服务
# ============================================================
class CamoufoxHandler(BaseHTTPRequestHandler):
    server_version = f'BossClaw-Camoufox/{VERSION}'

    def _send(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode('utf-8'))
        except Exception:
            return {}

    def do_OPTIONS(self):
        self._send(200, {})

    def do_GET(self):
        parsed = urlparse(self.path)
        token = parse_qs(parsed.query).get('token', [''])[0]
        if token != self.server.token:
            return self._send(403, {"ok": False, "error": "token denied"})
        if parsed.path == '/status':
            platform = (parse_qs(parsed.query).get('platform', ['boss'])[0] or 'boss').strip()
            payload = engine_status(platform)
            return self._send(200, payload)
        return self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        token = parse_qs(parsed.query).get('token', [''])[0]
        if token != self.server.token:
            return self._send(403, {"ok": False, "error": "token denied"})
        body = self._read_body()
        platform = str(body.get('platform') or 'boss').strip().lower() or 'boss'
        if platform not in PLATFORMS:
            return self._send(400, {"ok": False, "error": f"不支持的平台：{platform}"})

        try:
            if parsed.path == '/search':
                query = str(body.get('query') or '').strip()
                city = str(body.get('city') or '101010100').strip()
                pages = max(1, min(5, int(body.get('pages') or 1)))
                os_name = body.get('os') or None
                # 设置页「基础求职条件」（全平台共用）：猎聘/智联/前程无忧 由 platforms.filters
                # 翻译为各平台筛选参数（BOSS 走 searchUrl.ts + webview，此处忽略）。
                criteria = body.get('criteria') if isinstance(body.get('criteria'), dict) else {}
                # 定向重新采集（「任务进度」页「开始/继续」）：忽略断点续采，强制重采
                force = body.get('force') is True
                if not query:
                    return self._send(400, {"ok": False, "error": "缺少 query"})
                if platform == 'boss':
                    result = search_jobs(query, city, pages, os_name)
                else:
                    result = platform_mods.search_jobs(platform, query, city, pages, os_name, criteria, force)
                return self._send(200, result)

            if parsed.path == '/send':
                job_id = str(body.get('jobId') or body.get('job_id') or '').strip()
                greeting = str(body.get('greeting') or '').strip()
                os_name = body.get('os') or None
                if not job_id:
                    return self._send(400, {"ok": False, "error": "缺少 jobId"})
                if not greeting:
                    return self._send(400, {"ok": False, "error": "缺少 greeting", "code": 400})
                if platform == 'boss':
                    result = send_greeting(job_id, greeting, os_name)
                else:
                    job = {
                        "jobId": job_id,
                        "url": str(body.get('url') or ''),
                        "company": str(body.get('company') or ''),
                        "recruiterName": str(body.get('recruiterName') or ''),
                        "title": str(body.get('jobTitle') or ''),
                    }
                    result = platform_mods.deliver(platform, job, greeting, os_name)
                return self._send(200, result)

            if parsed.path == '/chat':
                job_id = str(body.get('jobId') or body.get('job_id') or '').strip()
                greeting = str(body.get('greeting') or '').strip()
                os_name = body.get('os') or None
                send_resume_image = bool(body.get('sendResumeImage'))
                send_online_resume = bool(body.get('sendOnlineResume'))
                expected = {
                    "recruiterName": str(body.get('recruiterName') or ''),
                    "company": str(body.get('company') or ''),
                    "jobTitle": str(body.get('jobTitle') or ''),
                }
                resume_images = body.get('resumeImages') or []
                mode = str(body.get('mode') or 'auto')
                reply_text = str(body.get('replyText') or '')
                # 附件延迟（秒，渲染层附件延迟设置透传；非法/缺失回落 4，0=不额外等待）
                try:
                    attachment_delay_seconds = float(body.get('attachmentDelaySeconds') or 4)
                except (TypeError, ValueError):
                    attachment_delay_seconds = 4.0
                if not job_id:
                    return self._send(400, {"ok": False, "error": "缺少 jobId"})
                # mode='check' 为只读巡检，无需 greeting；其余模式 greeting 必填
                if not greeting and mode != 'check':
                    return self._send(400, {"ok": False, "error": "缺少 greeting", "code": 400})
                # AI 跟聊巡检仅 BOSS 支持（其余平台回复请在平台 App 内人工跟进）
                if mode == 'check' and platform != 'boss':
                    return self._send(200, {"ok": False, "code": 400, "error": "AI 跟聊巡检仅支持 BOSS 平台"})
                if platform == 'boss':
                    result = chat_greeting(job_id, greeting, os_name, send_resume_image, send_online_resume,
                                           expected, resume_images, mode, reply_text, attachment_delay_seconds)
                else:
                    job = {
                        "jobId": job_id,
                        "url": str(body.get('url') or ''),
                        "company": str(body.get('company') or ''),
                        "recruiterName": str(body.get('recruiterName') or ''),
                        "title": str(body.get('jobTitle') or ''),
                    }
                    result = platform_mods.deliver(platform, job, greeting, os_name, send_resume_image,
                                                   send_online_resume, expected, resume_images, mode, reply_text)
                return self._send(200, result)

            if parsed.path == '/login':
                timeout = max(30, min(600, int(body.get('timeout') or 180)))
                os_name = body.get('os') or None
                if platform == 'boss':
                    result = do_login(timeout, os_name)
                else:
                    result = platform_mods.do_login(platform, timeout, os_name)
                return self._send(200, result)

            if parsed.path == '/logout':
                clear_cookies(platform)
                return self._send(200, {"ok": True, "loggedIn": False})

            # 常驻「AI 跟聊」会话监听：start / scan / open / send / stop / status
            # 命令在单线程执行器内串行执行（Playwright 线程亲和）；浏览器操作较慢，给足超时。
            if parsed.path == '/chat-watch':
                cmd = str(body.get('cmd') or '').strip().lower()
                if cmd not in CHAT_WATCH_ACTIONS:
                    return self._send(400, {"ok": False, "error": f"不支持的会话监听命令：{cmd}"})
                result = chat_watch_command(cmd, body, timeout=120.0)
                return self._send(200, result)

            if parsed.path == '/clear':
                clear_cookies(platform)
                return self._send(200, {"ok": True})

            # 平台能力矩阵（对齐 BossHunter collection/capabilities.py）：
            # 设置页 / 工作台据此判断某平台是否支持 collect / deliver / attach 等动作。
            if parsed.path == '/platforms':
                return self._send(200, {"ok": True, **platform_mods.platform_capabilities()})

            # 断点续采进度：查询 / 清除（clear=true 时清除，platform 可限定单平台）
            if parsed.path == '/collection-progress':
                if body.get('clear') is True:
                    target = platform if body.get('platform') else None
                    return self._send(200, platform_mods.clear_collection_progress(target))
                return self._send(200, {"ok": True, **platform_mods.collection_progress(platform)})

            return self._send(404, {"ok": False, "error": "not found"})
        except Exception as e:
            log('❌', f'处理异常：{e}')
            return self._send(500, {"ok": False, "error": str(e)})

    def log_message(self, fmt, *args):
        pass  # 静默访问日志


# 各平台登录态判定 Cookie（名称含关键字即视为已登录）
# 与 main.cjs `WEBVIEW_AUTH_COOKIE_HINTS` 同源：`=name` 精确匹配 / 嵌套元组 = 成对条件（需同时存在）。
PLATFORM_AUTH_COOKIE_HINTS = {
    'boss': ('wt2',),
    'liepin': ('lp_login', 'lp_token', 'token'),
    'zhaopin': ('zp_auto', 'zp_sign', 'swordman', 'zm_job_pc', ('=at', '=rt')),
    'job51': ('j_ticket', 'sajssp', '51job', 'job51'),
}


def _cookie_name_matches(name: str, hint: str) -> bool:
    """`=name` 精确匹配；其余子串匹配（沿用历史宽松语义）。"""
    if hint.startswith('='):
        return name == hint[1:]
    return name.startswith(hint) or hint in name


def _auth_hint_hit(cookies, hint) -> bool:
    """单个 hint（字符串=任一 cookie 命中；元组=成对条件需同时命中）。"""
    pats = hint if isinstance(hint, tuple) else (hint,)
    return all(
        any(c.get('value') and _cookie_name_matches(str(c.get('name', '')).lower(), p) for c in cookies)
        for p in pats
    )


def engine_status(platform: str = 'boss') -> dict:
    """检测隐身引擎可用性（不启动浏览器）：内核检测 + 指定平台 Cookie 状态。"""
    import importlib.util
    cf = cookie_file(platform)
    cookie_count = 0
    logged_in = False
    if cf.exists():
        try:
            with open(cf, encoding='utf-8') as f:
                cookies = json.load(f).get('cookies', [])
                cookie_count = len(cookies)
            # 登录态独立判定：仅按该平台鉴权 Cookie 命中（不靠匿名 cookie 数量，避免误判已登录）
            hints = PLATFORM_AUTH_COOKIE_HINTS.get(platform, PLATFORM_AUTH_COOKIE_HINTS['boss'])
            logged_in = any(_auth_hint_hit(cookies, hint) for hint in hints)
        except Exception:
            pass
    info = {
        "ok": False,
        "version": VERSION,
        "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        "camoufox": False,
        "camoufoxVersion": "",
        "playwright": False,
        "kernel": "none",
        "kernelPath": "",
        "kernelMessage": "",
        "platform": platform,
        "cookies": cf.exists(),
        "cookieCount": cookie_count,
        "loggedIn": logged_in,
        "message": "",
    }
    spec = importlib.util.find_spec('camoufox')
    if spec is not None:
        info["camoufox"] = True
        try:
            # 注意：camoufox 0.5.4 的 camoufox.__version__ 是 module 而非字符串，
            # 必须用 importlib.metadata 读版本号（否则 JSON 序列化报错）
            import importlib.metadata
            info["camoufoxVersion"] = importlib.metadata.version('camoufox')
        except Exception:
            pass
    if importlib.util.find_spec('playwright') is not None:
        info["playwright"] = True

    # 内核检测：仅 Camoufox 原生内核可用（本地 Chrome/Edge 不可复用，BOSS 反爬对 Playwright 驱动浏览器返回空壳）
    kernel = detect_kernel()
    info["kernel"] = kernel["kind"]
    info["kernelPath"] = kernel.get("path") or ""
    info["kernelMessage"] = kernel.get("message") or ""
    if kernel["kind"] != "none":
        info["ok"] = True
        info["message"] = kernel["message"]
    else:
        info["message"] = kernel["message"]
    return info


def main():
    parser = argparse.ArgumentParser(description='BossClaw Camoufox 隐身引擎桥')
    parser.add_argument('--port', type=int, default=18767)
    parser.add_argument('--token', default='bossclaw-camoufox')
    args = parser.parse_args()

    # 启动前先检测引擎可用性（内核 + Cookie）
    status = engine_status()
    log('🧪', f"内核={'✅ ' + status['kernel'] if status['kernel'] != 'none' else '❌ none'} "
              f"camoufox={'✅' if status['camoufox'] else '—'} "
              f"cookies={'✅' if status['cookieCount'] else '—'}")
    log('📦', status['message'])

    server = ThreadingHTTPServer(('127.0.0.1', args.port), CamoufoxHandler)
    server.token = args.token
    log('🚀', f'隐身引擎桥 listening on 127.0.0.1:{args.port} (v{VERSION})')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == '__main__':
    main()
