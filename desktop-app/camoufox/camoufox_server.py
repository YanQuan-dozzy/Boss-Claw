#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BossClaw 隐身引擎 —— 本地 Python 桥服务（多内核自适应）
============================================================
为 Boss-claw 桌面版提供隐身采集 / 投递能力。**不强制下载专用内核**，
按可用性自动选择浏览器内核（全部复用本机已装）：

  1. Camoufox 原生内核（若已 `camoufox fetch` 下载）→ C++ 级指纹伪装 + humanize
  2. 系统 Google Chrome（若已安装）            → Playwright + stealth 初始化
  3. 系统 Microsoft Edge（若已安装）            → Playwright + stealth 初始化
  4. 均不可用 → /status 返回 not ready，前端提示

能力（对齐 boss-auto-job-main）：
  - /status  检测可用内核与引擎状态
  - /search  隐身搜索（humanize/stealth，自动处理 code 37 环境检查）
  - /send    隐身发送招呼语（friend/add.json API + 页面真实点击兜底）
  - /chat    自动沟通（真正的浏览器操作：可见窗口真实点击「立即沟通」+ 真实键盘输入 + 发送 + 气泡确认）
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
import re
import sys
import time
import shutil
from contextlib import contextmanager
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

# ============================================================
# 路径与配置
# ============================================================
DATA_DIR = Path.home() / '.bossclaw'
COOKIE_FILE = DATA_DIR / 'camoufox-cookies.json'
DATA_DIR.mkdir(parents=True, exist_ok=True)

VERSION = '2.0.0'

# 可复用的系统浏览器内核候选路径（Windows 优先，macOS/Linux 兜底）
CHROME_CANDIDATES = [
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files\Google\Chrome\Application\chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
]
EDGE_CANDIDATES = [
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    r'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/microsoft-edge',
]
FIREFOX_CANDIDATES = [
    r'C:\Program Files\Mozilla Firefox\firefox.exe',
    r'C:\Program Files (x86)\Mozilla Firefox\firefox.exe',
    '/Applications/Firefox.app/Contents/MacOS/firefox',
    '/usr/bin/firefox',
]

# 内核检测结果缓存（进程生命周期内只检测一次）
_KERNEL_CACHE: dict | None = None


def log(icon: str, msg: str):
    ts = datetime.now().strftime('%H:%M:%S')
    print(f"[{ts}] {icon} {msg}", file=sys.stderr, flush=True)


# ============================================================
# Cookie 管理（对齐 send_camoufox.py 的格式）
# ============================================================
def load_cookies() -> list:
    if not COOKIE_FILE.exists():
        return []
    try:
        with open(COOKIE_FILE, encoding='utf-8') as f:
            auth = json.load(f)
    except Exception as e:
        log('⚠️', f'读取 Cookie 失败：{e}')
        return []
    pw_cookies = []
    for c in auth.get('cookies', []):
        cookie = {
            "name": c["name"], "value": c["value"],
            "domain": c["domain"], "path": c.get("path", "/"),
        }
        expires = c.get("expires", -1)
        if expires and expires > 0:
            cookie["expires"] = expires
        if c.get("httpOnly"):
            cookie["httpOnly"] = True
        if c.get("secure"):
            cookie["secure"] = True
        pw_cookies.append(cookie)
    return pw_cookies


def save_cookies(context) -> int:
    """导出会话 Cookie 回持久化文件（带备份）。"""
    try:
        all_cookies = context.cookies()
    except Exception as e:
        log('⚠️', f'导出 Cookie 失败：{e}')
        return 0
    export = []
    for c in all_cookies:
        export.append({
            "name": c["name"], "value": c["value"], "domain": c["domain"],
            "path": c.get("path", "/"), "expires": c.get("expires", -1),
            "size": len(c.get("value", "")), "httpOnly": c.get("httpOnly", False),
            "secure": c.get("secure", False), "session": c.get("expires", -1) == -1,
        })
    if COOKIE_FILE.exists():
        try:
            backup = COOKIE_FILE.parent / (COOKIE_FILE.stem + '.backup.json')
            shutil.copy(COOKIE_FILE, backup)
        except Exception:
            pass
    with open(COOKIE_FILE, 'w', encoding='utf-8') as f:
        json.dump({"cookies": export, "origins": []}, f, ensure_ascii=False, indent=2)
    log('💾', f'Cookie 已持久化：{len(export)} 条 → {COOKIE_FILE}')
    return len(export)


# ============================================================
# 内核检测与浏览器启动（多内核自适应：Camoufox → Chrome → Edge）
# ============================================================
def detect_kernel(force: bool = False) -> dict:
    """检测可用的浏览器内核。返回：
    {'kind': 'camoufox'|'chrome'|'edge'|'none', 'path': str|None, 'camoufox': bool, 'message': str}
    优先级：Camoufox 原生内核（C++ 级） > 系统 Chrome > 系统 Edge。
    """
    global _KERNEL_CACHE
    if _KERNEL_CACHE and not force:
        return _KERNEL_CACHE

    # 1) Camoufox 原生内核（已 camoufox fetch 下载 Firefox）
    try:
        import camoufox
        from camoufox.utils import installed_verstr
        if installed_verstr():
            _KERNEL_CACHE = {
                "kind": "camoufox", "path": None, "camoufox": True,
                "message": "Camoufox 原生内核（C++ 级指纹伪装）",
            }
            return _KERNEL_CACHE
    except Exception:
        pass

    # 2) 系统 Chrome
    for p in CHROME_CANDIDATES:
        if Path(p).exists():
            _KERNEL_CACHE = {
                "kind": "chrome", "path": p, "camoufox": False,
                "message": f"复用系统 Chrome（{p}）+ Playwright stealth",
            }
            return _KERNEL_CACHE

    # 3) 系统 Edge
    for p in EDGE_CANDIDATES:
        if Path(p).exists():
            _KERNEL_CACHE = {
                "kind": "edge", "path": p, "camoufox": False,
                "message": f"复用系统 Edge（{p}）+ Playwright stealth",
            }
            return _KERNEL_CACHE

    _KERNEL_CACHE = {
        "kind": "none", "path": None, "camoufox": False,
        "message": "未检测到可用内核：请安装 Chrome/Edge/Firefox，或执行 camoufox fetch 下载原生内核",
    }
    return _KERNEL_CACHE


# Chromium 系（Chrome/Edge）的 stealth 初始化脚本：
# 隐藏 navigator.webdriver、chrome.runtime、CDP 痕迹等自动化特征（JS 级，尽力而为；
# C++ 级伪装需 Camoufox 原生内核——本引擎自动优先使用，没有则退化到 Chromium+stealth）
def stealth_init_script() -> str:
    return """
    // === BossClaw stealth (Chromium) ===
    // 1) navigator.webdriver 不可见
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // 2) 模拟 chrome.runtime（部分检测点会读取）
    try {
      if (!window.chrome) window.chrome = {};
      if (!window.chrome.runtime) {
        window.chrome.runtime = {
          connect: () => ({ postMessage: () => {}, disconnect: () => {} }),
          sendMessage: () => {},
          id: undefined,
        };
      }
      if (!window.chrome.app) window.chrome.app = { isInstalled: false };
      if (!window.chrome.csi) window.chrome.csi = () => ({});
      if (!window.chrome.loadTimes) window.chrome.loadTimes = () => ({});
    } catch (e) {}
    // 3) 隐藏 Playwright/CDP 痕迹（尽力而为）
    try {
      const origQuery = window.navigator.permissions && window.navigator.permissions.query;
      if (origQuery) {
        window.navigator.permissions.query = (parameters) => (
          parameters && parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : origQuery(parameters)
        );
      }
    } catch (e) {}
    // 4) 统一语言/时区外观
    try {
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5].map((i) => ({ name: 'Plugin ' + i, filename: 'plugin' + i + '.dll', description: '' })),
      });
    } catch (e) {}
    // 5) WebGL 渲染器信息收敛为常见值（尽力而为；C++ 级需 Camoufox）
    try {
      const getExt = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        const ctx = getExt.call(this, type, ...args);
        if (ctx && (type === 'webgl' || type === 'experimental-webgl')) {
          const getParam = ctx.getParameter.bind(ctx);
          const isExt = (name) => {
            try { return Boolean(ctx.getExtension(name)); } catch (e) { return false; }
          };
          if (isExt('WEBGL_debug_renderer_info')) {
            const ext = ctx.getExtension('WEBGL_debug_renderer_info');
            const UNMASKED_VENDOR = 0x9245, UNMASKED_RENDERER = 0x9246;
            try {
              Object.defineProperty(ctx, 'getParameter', {
                value: (p) => {
                  if (p === UNMASKED_VENDOR) return 'Google Inc. (Intel)';
                  if (p === UNMASKED_RENDERER) return 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)';
                  return getParam(p);
                },
              });
            } catch (e) {}
          }
        }
        return ctx;
      };
    } catch (e) {}
    """


@contextmanager
def open_browser(os_name: str | None = None, headless: bool = False):
    """按检测到的内核打开浏览器，yield page；退出时自动关闭。
    Camoufox 内核：humanize + geoip（C++ 级）；Chromium：stealth 初始化脚本。"""
    kernel = detect_kernel()
    if kernel["kind"] == "camoufox":
        from camoufox.sync_api import Camoufox
        kwargs = {"humanize": True, "geoip": True, "block_images": False}
        if os_name:
            kwargs["os"] = os_name
        if headless:
            kwargs["headless"] = "virtual"
        with Camoufox(**kwargs) as browser:
            page = browser.new_page()
            yield page
        return

    # Chromium 系：Playwright + 系统浏览器可执行文件（无需下载任何内核）
    from playwright.sync_api import sync_playwright
    exe = kernel.get("path")
    launch_args = {
        "headless": headless,
        "args": [
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
            "--disable-infobars",
            "--disable-features=AutomationControlled",
            "--lang=zh-CN",
            "--disable-blink-features=IdleDetection",
        ],
        # 剔除 Playwright 默认的 --enable-automation 等自动化特征参数（BOSS 环境检测关键项）
        "ignore_default_args": [
            "--enable-automation",
            "--enable-blink-features=IdleDetection",
            "--disable-component-update",
        ],
    }
    if exe:
        launch_args["executable_path"] = exe
    with sync_playwright() as p:
        browser = p.chromium.launch(**launch_args)
        context = browser.new_context(
            viewport={"width": 1366, "height": 850},
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            ),
        )
        context.add_init_script(stealth_init_script())
        page = context.new_page()
        yield page
        try:
            browser.close()
        except Exception:
            pass


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
                time.sleep(5)
                try:
                    page.wait_for_function("() => document.body && document.body.innerText.length > 0", timeout=15000)
                except Exception:
                    pass
                time.sleep(1)
                current_url = page.url
                log('🔗', f'URL: {current_url[:110]} (status={resp.status if resp else "?"})')

                if "security-check" in current_url:
                    log('⚠️', '触发安全检查页，等待自动处理…')
                    time.sleep(8)
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
                api_result = None
                for attempt in range(3):
                    try:
                        api_result = page.evaluate(f"""
                            () => fetch('/wapi/zpgeek/search/joblist.json?scene=1&query={query}&city={city}&page={page_num}&pageSize=30')
                                .then(r => r.json())
                                .catch(e => ({{error: e.message}}))
                        """)
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
                            retry = page.evaluate(f"""
                                () => fetch('/wapi/zpgeek/search/joblist.json?scene=1&query={query}&city={city}&page={page_num}&pageSize=30')
                                    .then(r => r.json())
                            """)
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
                time.sleep(delay)

    # 保存会话 Cookie（登录态可能已在访问中刷新）
    try:
        # context 已随 with 关闭，Cookie 由后续 login/send 保存；此处仅记录
        pass
    except Exception:
        pass

    # 风险码透传：code 36/32/35/37/38 交给渲染层统一分类
    if last_code in (36, 32, 35, 37, 38):
        return {"ok": False, "code": last_code, "message": last_msg, "jobs": []}

    formatted = format_jobs(all_jobs)
    log('🎉', f'搜索完成：共 {len(formatted)} 个岗位')
    return {"ok": True, "code": 0, "jobs": formatted}


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
        time.sleep(3)
        if "security-check" in page.url:
            log('⚠️', '会话页触发安全检查，等待…')
            time.sleep(8)
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
                card = page.evaluate(f"""
                    () => fetch('/wapi/zpgeek/job/card.json?encryptJobId={job_id}', {{
                        credentials: 'include',
                        headers: {{'X-Requested-With': 'XMLHttpRequest'}}
                    }}).then(r => r.json()).catch(e => ({{error: e.message}}))
                """)
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
            card = page.evaluate(f"""
                () => fetch('/wapi/zpgeek/job/card.json?encryptJobId={job_id}', {{
                    credentials: 'include',
                    headers: {{'X-Requested-With': 'XMLHttpRequest'}}
                }}).then(r => r.json()).catch(e => ({{error: e.message}}))
            """)
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
                        time.sleep(8)
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
            time.sleep(5)
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
                log('✅', '已在沟通过程中（按钮=继续沟通），视为已建立会话')
                return {"ok": True, "code": 0, "sent": True, "method": "click-already"}
            if state['state'] == 'not_found':
                save_cookies(page.context)
                return {"ok": False, "code": 404, "message": "未找到沟通按钮（可能岗位已下架）", "sent": False}
            page.locator("text=立即沟通").first.click(timeout=5000)
            time.sleep(5)
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
                log('✅', '已通过页面点击建立沟通（后续招呼语请在 BOSS 内补充）')
                return {"ok": True, "code": 0, "sent": True, "method": "click"}
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
    """真实点击沟通按钮：JS 精确定位（最短文本的可见叶子元素）→ 打临时标记 → Playwright 原生 click。"""
    try:
        marker = 'data-bossclaw-chat-btn'
        ok = page.evaluate("""(state, marker) => {
            const all = Array.from(document.querySelectorAll('button, a, [role="button"], span, div, i'));
            const text = (el) => (el.textContent || '').trim().replace(/\\s+/g, ' ');
            const visible = (el) => {
                try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
                catch (e) { return false; }
            };
            const re = new RegExp(state.replace(/\\s+/g, '\\\\s*'));
            const hits = all.filter(el =>
                visible(el) && text(el).length <= 12 && re.test(text(el)) &&
                !(el.closest('[class*="dialog"],[class*="modal"]') || el.matches('[class*="dialog"] *,[class*="modal"] *'))
            );
            if (!hits.length) return false;
            hits.sort((a, b) => text(a).length - text(b).length);
            hits[0].setAttribute(marker, '1');
            return true;
        }""", state_label, marker)
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
    """定位可见的聊天输入框，优先 #chat-input（AI-BossJob-plus 稳定 id，BOSS 新版即 contenteditable），
    排除搜索框，返回 Playwright Locator。会在主页面及弹出的聊天窗口页面中查找。"""
    pages = _all_pages(page)
    for p in pages:
        for sel in ['#chat-input', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
                    'div[contenteditable]', 'textarea', 'input[type="text"]']:
            try:
                loc = p.locator(sel)
                count = loc.count()
                for i in range(count):
                    el = loc.nth(i)
                    try:
                        if not el.is_visible():
                            continue
                    except Exception:
                        continue
                    ph = ''
                    try:
                        ph = str(el.get_attribute('placeholder') or '') + str(el.get_attribute('aria-label') or '')
                    except Exception:
                        pass
                    if '搜索' in ph or 'search' in ph.lower():
                        continue
                    # #chat-input / contenteditable / textarea 视为聊天输入区；input 需 placeholder 含回复/消息等
                    if sel in ('#chat-input', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
                               'div[contenteditable]', 'textarea'):
                        return el
                    if re.search(r'回复|消息|输入|打招呼|沟通', ph):
                        return el
            except Exception:
                continue
    return None


def _input_text(page) -> str:
    """读取聊天输入框当前内容（校验输入是否成功）。"""
    try:
        return str(page.evaluate("""() => {
            const input = document.querySelector('#chat-input, [contenteditable="true"], [contenteditable="plaintext-only"], div[contenteditable], textarea');
            if (!input) return '';
            if (input.isContentEditable) return input.innerText || input.textContent || '';
            return input.value || '';
        }""") or '')
    except Exception:
        return ''


def _inject_text_via_exec(page, greeting: str) -> bool:
    """兜底注入：execCommand('insertText')（AI-BossJob-plus sendCustomReply 同款，React 受控组件可感知）。"""
    try:
        ok = page.evaluate("""(text) => {
            const input = document.querySelector('#chat-input, [contenteditable="true"], [contenteditable="plaintext-only"], div[contenteditable], textarea');
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
        }""", greeting)
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


def _confirm_message(page, greeting: str) -> bool:
    """文字气泡确认（兜底）：发送后聊天记录里出现刚发送的文字（安全不变量：未确认不计成功）。"""
    needle = ' '.join(str(greeting or '').split())[:30]
    if not needle:
        return False
    try:
        found = page.evaluate("""
            (needle) => {
                const sels = ['.chat-message .im-list', '.im-list', '.chat-conversation', '.conversation',
                              '.message-list', '[class*="message"]', '[class*="chat-content"]', '[class*="conversation"]'];
                const clean = (t) => (t || '').replace(/[\\u200b-\\u200d\\ufeff\\u2060]/g, ' ').replace(/\\s+/g, ' ');
                for (const sel of sels) {
                    const els = document.querySelectorAll(sel);
                    for (const el of els) {
                        if (el.closest && el.closest('[contenteditable],textarea,input')) continue;
                        if (clean(el.innerText || el.textContent).includes(needle)) return true;
                    }
                }
                return false;
            }
        """, needle)
        return bool(found)
    except Exception:
        return False


def _find_send_button(page):
    """定位发送按钮：优先 `.btn-send`（AI-BossJob-plus），其次 class 含 send，再按文本「发送」。
    不要求按钮文本含「发送」（BOSS 图标按钮可能只有图标）。"""
    try:
        btn = page.locator('.btn-send').first
        if btn.is_visible(timeout=1500):
            return btn, 'btn-send'
    except Exception:
        pass
    try:
        btn = page.locator("[class*='send']:visible").first
        if btn.is_visible(timeout=800):
            return btn, 'class-send'
    except Exception:
        pass
    try:
        btn = page.locator("button:has-text('发送'), [role='button']:has-text('发送')").first
        if btn.is_visible(timeout=800):
            return btn, 'text-send'
    except Exception:
        pass
    return None, None


def chat_greeting(job_id: str, greeting: str, os_name: str | None = None,
                  send_resume_image: bool = False, send_online_resume: bool = False) -> dict:
    greeting = str(greeting or '').strip()
    if not greeting:
        return {"ok": False, "code": 400, "message": "招呼语为空，拒绝沟通", "sent": False}
    if len(greeting) > 800:
        return {"ok": False, "code": 400, "message": "招呼语过长（>800 字），拒绝沟通", "sent": False}

    log('💬', f'自动沟通 → job={job_id}（{len(greeting)} 字，可见窗口）')

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
        time.sleep(3)
        if "verify" in page.url:
            return {"ok": False, "code": 35, "message": "需要人工安全验证", "sent": False}
        if "security-check" in page.url:
            log('⚠️', '会话页触发安全检查，等待…')
            time.sleep(8)
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
                card = page.evaluate(f"""
                    () => fetch('/wapi/zpgeek/job/card.json?encryptJobId={job_id}', {{
                        credentials: 'include',
                        headers: {{'X-Requested-With': 'XMLHttpRequest'}}
                    }}).then(r => r.json()).catch(e => ({{error: e.message}}))
                """)
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
        time.sleep(5)
        if "verify" in page.url:
            return {"ok": False, "code": 35, "message": "需要人工安全验证", "sent": False}
        risk = _risk_text_hit(page)
        if risk:
            return {"ok": False, "code": 35, "message": f"检测到安全验证/访问受限（{risk}），已暂停，请人工完成验证", "sent": False}

        # Step 4: 找到并真实点击「立即沟通 / 继续沟通」
        state = _chat_button_state(page)
        log('🖱️', f'按钮状态：{state}')
        if state == 'not_found':
            save_cookies(page.context)
            return {"ok": False, "code": 404, "message": "未找到沟通按钮（岗位可能已下架）", "sent": False}
        # 优先精确定位叶子按钮（text= 是子串匹配，可能点到外层容器）
        clicked = _click_chat_button(page, state)
        if not clicked:
            try:
                page.locator(f"text={state}").first.click(timeout=3000)
                clicked = True
            except Exception:
                pass
        if not clicked:
            save_cookies(page.context)
            return {"ok": False, "code": 500, "message": "点击沟通按钮失败", "sent": False}
        log('🖱️', f'已真实点击「{state}」，等待沟通窗口…')

        # Step 5: 等待聊天输入框出现；期间自动点掉确认弹窗、检测安全验证
        input_el = None
        deadline = time.time() + 20
        while time.time() < deadline:
            for p in _all_pages(page):
                risk = _risk_text_hit(p)
                if risk:
                    save_cookies(page.context)
                    return {"ok": False, "code": 35,
                            "message": f"检测到安全验证/访问受限（{risk}），已暂停，请人工完成验证", "sent": False}
                try:
                    _dismiss_chat_modal(p)
                except Exception:
                    pass
                input_el = _find_chat_input(p)
                if input_el is not None:
                    break
            if input_el is not None:
                break
            time.sleep(0.6)
        if input_el is None:
            save_cookies(page.context)
            return {"ok": False, "code": 500, "message": "未找到聊天输入框（沟通窗口可能未打开或被验证拦截）", "sent": False}

        # 聊天输入框所在页面（可能是弹出的新窗口），后续键盘/发送/确认都在该页执行
        try:
            target_page = input_el.page or page
        except Exception:
            target_page = page
        try:
            target_page.bring_to_front()
        except Exception:
            pass

        # Step 6: 发送前快照自己气泡数（AI-BossJob-plus 气泡确认闸门）
        before_count = _count_own_messages(target_page)

        # Step 7: 真实输入招呼语（聚焦 → 清空 → 逐字输入；内容为空则 execCommand 兜底）
        try:
            input_el.click()
            time.sleep(0.5)
            target_page.keyboard.press('ControlOrMeta+a')
            target_page.keyboard.press('Delete')
            target_page.keyboard.type(greeting, delay=25)
            time.sleep(0.6)
            typed = _input_text(target_page)
            if not typed.strip() or len(typed.strip()) < 5:
                log('⚠️', '键盘输入后内容为空，execCommand 兜底注入…')
                _inject_text_via_exec(target_page, greeting)
                time.sleep(0.5)
            log('⌨️', '招呼语已真实输入')
        except Exception as e:
            save_cookies(page.context)
            return {"ok": False, "code": 500, "message": f"输入招呼语失败：{e}", "sent": False}

        # Step 8: 发送（优先 .btn-send / class 含 send / 文本「发送」按钮，最后回车）
        sent_via = 'enter'
        send_btn, send_kind = _find_send_button(target_page)
        if send_btn is not None:
            try:
                send_btn.click()
                sent_via = send_kind or 'button'
                log('🖱️', f'已点击发送按钮（{sent_via}）')
            except Exception:
                try:
                    target_page.keyboard.press('Enter')
                    log('⌨️', '发送按钮点击失败，已回车发送')
                except Exception:
                    pass
        else:
            try:
                target_page.keyboard.press('Enter')
                log('⌨️', '已回车发送')
            except Exception:
                pass
        time.sleep(2)

        # Step 9: 发送结果确认 —— 气泡计数为主，文字匹配兜底（安全不变量：未确认不计成功）
        confirmed = _confirm_bubble_count(target_page, before_count)
        if not confirmed:
            confirmed = _confirm_message(target_page, greeting)
        if not confirmed:
            time.sleep(3)
            confirmed = _confirm_bubble_count(target_page, before_count) or _confirm_message(target_page, greeting)
        if not confirmed:
            save_cookies(page.context)
            return {"ok": False, "code": 501, "message": "未能确认文字气泡已发送，请人工核对", "sent": False}
        log('✅', f'文字气泡确认（发送方式：{sent_via}）')

        # Step 10: 可选 —— 发送在线简历（在聊天输入框所在页操作）
        if send_online_resume:
            try:
                for p in _all_pages(page):
                    try:
                        online_btn = p.locator("text=发送在线简历").first
                        if online_btn.is_visible(timeout=1500):
                            online_btn.click()
                            time.sleep(1.5)
                            log('📄', '已点击「发送在线简历」')
                            break
                    except Exception:
                        continue
            except Exception:
                log('⚠️', '发送在线简历失败（忽略）')
        if send_resume_image:
            log('ℹ️', '图片简历发送：请在 BOSS 聊天窗口内手动补发（自动发图待接入）')

        save_cookies(page.context)
        return {"ok": True, "code": 0, "sent": True, "method": "browser-chat", "sentVia": sent_via}


# ============================================================
# 扫码登录（打开可见窗口，等待用户扫码）
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
        page.goto("https://www.zhipin.com/web/user/?ka=header-login",
                  wait_until="domcontentloaded", timeout=30000)
        time.sleep(3)

        start = time.time()
        last_count = 0
        while time.time() - start < timeout:
            current = page.url
            if ("login" not in current and "user" not in current and "zhipin.com" in current) or \
               ("verify" not in current and "login" not in current and "user" not in current):
                # 已跳离登录页，视为登录成功
                log('✅', f'URL 已跳转：{current[:80]}')
                save_cookies(page.context)
                return {"ok": True, "loggedIn": True}
            cookies_now = page.context.cookies()
            if len(cookies_now) != last_count:
                last_count = len(cookies_now)
                log('👀', f'等待扫码中…（cookies: {last_count}）')
            time.sleep(2)

        log('❌', '登录超时')
        return {"ok": False, "code": 31, "message": "扫码登录超时，请重试"}


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
            payload = engine_status()
            return self._send(200, payload)
        return self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        token = parse_qs(parsed.query).get('token', [''])[0]
        if token != self.server.token:
            return self._send(403, {"ok": False, "error": "token denied"})
        body = self._read_body()

        try:
            if parsed.path == '/search':
                query = str(body.get('query') or '').strip()
                city = str(body.get('city') or '101010100').strip()
                pages = max(1, min(5, int(body.get('pages') or 1)))
                os_name = body.get('os') or None
                if not query:
                    return self._send(400, {"ok": False, "error": "缺少 query"})
                result = search_jobs(query, city, pages, os_name)
                return self._send(200, result)

            if parsed.path == '/send':
                job_id = str(body.get('jobId') or body.get('job_id') or '').strip()
                greeting = str(body.get('greeting') or '').strip()
                os_name = body.get('os') or None
                if not job_id:
                    return self._send(400, {"ok": False, "error": "缺少 jobId"})
                if not greeting:
                    return self._send(400, {"ok": False, "error": "缺少 greeting", "code": 400})
                result = send_greeting(job_id, greeting, os_name)
                return self._send(200, result)

            if parsed.path == '/chat':
                job_id = str(body.get('jobId') or body.get('job_id') or '').strip()
                greeting = str(body.get('greeting') or '').strip()
                os_name = body.get('os') or None
                send_resume_image = bool(body.get('sendResumeImage'))
                send_online_resume = bool(body.get('sendOnlineResume'))
                if not job_id:
                    return self._send(400, {"ok": False, "error": "缺少 jobId"})
                if not greeting:
                    return self._send(400, {"ok": False, "error": "缺少 greeting", "code": 400})
                result = chat_greeting(job_id, greeting, os_name, send_resume_image, send_online_resume)
                return self._send(200, result)

            if parsed.path == '/login':
                timeout = max(30, min(600, int(body.get('timeout') or 180)))
                os_name = body.get('os') or None
                result = do_login(timeout, os_name)
                return self._send(200, result)

            if parsed.path == '/logout':
                if COOKIE_FILE.exists():
                    COOKIE_FILE.unlink()
                    log('🗑️', '已清除 Camoufox Cookie')
                return self._send(200, {"ok": True, "loggedIn": False})

            if parsed.path == '/clear':
                if COOKIE_FILE.exists():
                    COOKIE_FILE.unlink()
                return self._send(200, {"ok": True})

            return self._send(404, {"ok": False, "error": "not found"})
        except Exception as e:
            log('❌', f'处理异常：{e}')
            return self._send(500, {"ok": False, "error": str(e)})

    def log_message(self, fmt, *args):
        pass  # 静默访问日志


def engine_status() -> dict:
    """检测隐身引擎可用性（不启动浏览器）：内核检测 + Cookie 状态。"""
    import importlib.util
    info = {
        "ok": False,
        "version": VERSION,
        "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        "camoufox": False,
        "camoufoxVersion": "",
        "kernel": "none",
        "kernelPath": "",
        "kernelMessage": "",
        "cookies": COOKIE_FILE.exists(),
        "cookieCount": 0,
        "message": "",
    }
    if COOKIE_FILE.exists():
        try:
            with open(COOKIE_FILE, encoding='utf-8') as f:
                info["cookieCount"] = len(json.load(f).get('cookies', []))
        except Exception:
            pass
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

    # 内核检测：Camoufox 原生 > Chrome > Edge（不下载任何新内核，全部复用本机已装浏览器）
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
