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
# 人类化抖动（对齐 AGENTS.md「只做主动降频、加入人类化抖动，绝不绕过」）
# 让真实打字/点击/翻页的节奏带随机游走，更接近真人操作，降低被误判为机器人的概率。
# ============================================================
def human_delay(seconds: float, jitter_ratio: float = 0.35, min_seconds: float = 0.0) -> float:
    """在 base 秒基础上叠加 ±ratio 的随机游走，返回实际需等待的秒数。
    例：human_delay(5) → 约 3.25s ~ 6.75s。保证不低于 min_seconds。"""
    base = max(0.0, seconds)
    width = base * jitter_ratio
    return max(min_seconds, base - width + random.random() * width * 2)


def human_sleep(seconds: float, jitter_ratio: float = 0.35, min_seconds: float = 0.0, rng=None):
    """人类化随机关心（对 status 透传时也可传 rng）。"""
    return time.sleep(human_delay(seconds, jitter_ratio, min_seconds))


def type_greeting_human(page, text: str, os_name: str | None = None):
    """真实键盘逐字输入招呼语，带随机打字节奏（对齐 job-claw content 逐字输入 + AI-BossJob 输入链）。
    每次按下间隔在 20~120ms 内随机游走（中文可略慢），接近真人打字而非固定 delay=25 的机械脉冲。
    若平台支持 os 键位则忽略（仅保留签名兼容）。
    """
    for ch in text:
        delay = random.randint(20, 120)
        # 中文 / 全角标点略慢，模拟真人敲中文拼音后选字
        if ord(ch) > 127:
            delay = random.randint(40, 140)
        page.keyboard.type(ch, delay=delay)
    return True


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
# 内核检测与浏览器启动（仅 Camoufox 原生隐身内核）
# 实测：BOSS 会对 Playwright 驱动的系统 Chrome/Edge 返回空壳页，本地浏览器不能复用，
# 只有 Camoufox 原生内核（C++ 级指纹伪装）可正常加载/沟通。
# ============================================================
def detect_kernel(force: bool = False) -> dict:
    """检测可用的隐身内核。返回：
    {'kind': 'camoufox'|'none', 'path': str|None, 'camoufox': bool, 'message': str}
    仅 Camoufox 原生内核可用；系统 Chrome/Edge/Firefox 不参与回退（无法通过 BOSS 反爬）。
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
                "message": "Camoufox 隐身引擎内核（C++ 级指纹伪装）",
            }
            return _KERNEL_CACHE
    except Exception:
        pass

    # 2) 未安装隐身引擎内核：本地系统浏览器不可复用（BOSS 反爬对 Playwright 驱动的 Chrome 返回空壳页）
    _KERNEL_CACHE = {
        "kind": "none", "path": None, "camoufox": False,
        "message": "隐身引擎未就绪：本地 Chrome/Edge 不可复用，请安装 Camoufox 原生内核：pip install \"camoufox[geoip]\" && camoufox fetch",
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
    """按检测到的内核打开浏览器，yield page；退出时自动关闭。仅 Camoufox 原生内核可用。"""
    kernel = detect_kernel()
    if kernel["kind"] == "camoufox":
        from camoufox.sync_api import Camoufox
        kwargs = {"humanize": True, "block_images": False}
        if os_name:
            kwargs["os"] = os_name
        if headless:
            kwargs["headless"] = "virtual"
        # 注意：不开 geoip=，避免每次启动 Camoufox 都调用 public_ip() 外网请求
        # （网络不佳时会长时间阻塞/挂起，导致登录初始加载卡顿）。指纹伪装不含 geoip 即可通过 BOSS。
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
                human_sleep(delay, 0.4, 1.5)

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
                log('✅', '已在沟通过程中（按钮=继续沟通），视为已建立会话')
                return {"ok": True, "code": 0, "sent": True, "method": "click-already"}
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
    """读取 HR 发来的消息（对齐 AI-BossJob getLastFriendMessageText / hasHRResponded）：
    统计 `li.message-item.item-friend` 消息数并取最新一条**非系统提示**的文本（`.text span`），
    用于判断是否需要「AI 跟聊」回复。无 HR 真实消息返回 {count:0, last:''}。"""
    try:
        r = page.evaluate("""() => {
            const c = document.querySelector('.chat-message .im-list, [class*="chat-message"] [class*="im-list"]');
            if (!c) return { count: 0, last: '' };
            const friends = Array.from(c.querySelectorAll('li.message-item.item-friend, li[class*="item-friend"]'))
                .filter(el => el.getBoundingClientRect().width > 0);
            if (!friends.length) return { count: 0, last: '' };
            const clean = (s) => (s || '').replace(/[\\u200b-\\u200d\\ufeff\\u2060]/g, ' ').trim().replace(/\\s+/g, ' ').slice(0, 800);
            // 跳过 BOSS 系统/提示类消息（打招呼确认、等待回复、简历被查看等），取最新一条「真实 HR 消息」
            const sysRe = /已向(TA|.{1,6})打了招呼|等待对方回复|请耐心等待|BOSS推荐|简历已被查看|系统消息|非常抱歉|未读/;
            for (let i = friends.length - 1; i >= 0; i--) {
                const f = friends[i];
                const t = f.querySelector('.text span, [class*="text"] span, [class*="content"]') || f;
                const s = clean(t ? t.textContent : '');
                if (s && !sysRe.test(s)) return { count: friends.length, last: s };
            }
            return { count: friends.length, last: '' };
        }""") or {}
        return r
    except Exception:
        return {'count': 0, 'last': ''}


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


def _upload_resume_images(page, resume_images: list) -> dict:
    """上传图片简历（对齐 AI-BossJob sendResume + job-claw uploadResumeImage）：
    打开「图片/发送简历/附件」入口，用 Playwright set_input_files 注入内存图片，等待片刻。
    图片为可选项：失败不阻断已确认的文字沟通。"""
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
        # 打开上传入口
        try:
            page.evaluate("""() => {
                const vas = (el) => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch (e) { return false; } };
                const text = (el) => (el.textContent || '').trim().replace(/\\s+/g, ' ');
                const btns = Array.from(document.querySelectorAll('button,[role="button"],a,span,div,[class*="attach"],[class*="img"]'))
                    .filter(el => vas(el) && /发送简历|图片|附件/.test((el.className || '') + ' ' + text(el)));
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


def chat_greeting(job_id: str, greeting: str, os_name: str | None = None,
                  send_resume_image: bool = False, send_online_resume: bool = False,
                  expected: dict | None = None, resume_images: list | None = None,
                  mode: str = 'auto', reply_text: str | None = None) -> dict:
    # mode: 'auto' 首次打招呼投递（若 HR 已发来消息则转「AI 跟聊」返回 700）；
    #       'reply' 发送渲染层生成的 AI 回复文本（对齐 AI-BossJob aiReply 链路）。
    if mode == 'reply':
        send_text = str(reply_text or greeting or '').strip()
        scope_label = 'AI 回复'
    else:
        send_text = str(greeting or '').strip()
        scope_label = '打招呼'
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
        if input_el is None:
            save_cookies(page.context)
            err = target_page or {}
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

        # Step 5.7: 判断是否需要「AI 跟聊」——HR 已发来消息（对齐 AI-BossJob 跟聊触发）。
        # 不发送打招呼语，仅返回 HR 最新消息供渲染层生成 AI 回复后走 mode='reply' 发送。
        if mode != 'reply':
            hr_ctx = _read_hr_friend_context(target_page)
            if hr_ctx.get('count', 0) > 0 and hr_ctx.get('last'):
                save_cookies(page.context)
                return {"ok": False, "code": 700, "needsReply": True, "hasHrMessage": True,
                        "hrLastMessage": hr_ctx.get('last', ''),
                        "message": "HR 已发来消息，进入 AI 跟聊回复", "sent": False}

        # Step 6: 发送前快照自己气泡指纹（对齐 waitForStableOutgoingGreeting 的 before 快照）
        before_fps = _outgoing_message_fingerprints(target_page)

        # Step 7: 真实输入招呼语（聚焦 → 清空 → 逐字随机输入；内容为空则 execCommand 兜底）
        try:
            input_el.click()
            # 点击后短暂停顿，模拟真人移动鼠标/停留
            human_sleep(0.4, 0.5)
            target_page.keyboard.press('ControlOrMeta+a')
            target_page.keyboard.press('Delete')
            # 逐字随机打字节奏（接近真人，替代固定 delay=25）
            type_greeting_human(target_page, send_text)
            human_sleep(0.5, 0.4)
            typed = _input_text(target_page)
            if not typed.strip() or len(typed.strip()) < 5:
                log('⚠️', '键盘输入后内容为空，execCommand 兜底注入…')
                _inject_text_via_exec(target_page, send_text)
                human_sleep(0.4, 0.5)
            log('⌨️', '招呼语已真实输入')
        except Exception as e:
            save_cookies(page.context)
            return {"ok": False, "code": 500, "message": f"输入招呼语失败：{e}", "sent": False}

        # Step 8: 发送（优先聊天输入区邻近「发送」按钮，避免误点「发送简历」，最后回车）
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

        # Step 9: 发送结果确认 —— 稳定指纹 ×3 + 完整目标文字匹配（安全不变量：未确认不计成功）
        confirmed = _confirm_message(target_page, send_text, before_fps)
        if not confirmed:
            human_sleep(2.6, 0.3, 1.5)
            confirmed = _confirm_message(target_page, send_text, before_fps)
        if not confirmed:
            save_cookies(page.context)
            return {"ok": False, "code": 501, "message": "未能确认文字气泡已发送，请人工核对", "sent": False}
        log('✅', f'文字气泡确认（发送方式：{sent_via}）')

        # Step 10: 可选 —— 在线简历 / 图片简历
        if send_online_resume:
            try:
                for p in _all_pages(page):
                    try:
                        online_btn = p.locator("text=发送在线简历").first
                        if online_btn.is_visible(timeout=1500):
                            online_btn.click()
                            human_sleep(1.3, 0.3, 0.6)
                            log('📄', '已点击「发送在线简历」')
                            break
                    except Exception:
                        continue
            except Exception:
                log('⚠️', '发送在线简历失败（忽略）')
        if send_resume_image and resume_images:
            _upload_resume_images(target_page, resume_images)

        save_cookies(page.context)
        return {"ok": True, "code": 0, "sent": True, "method": "browser-chat", "sentVia": sent_via}


# ============================================================
# 扫码登录（打开可见窗口，等待用户扫码）
# ============================================================
def goto_stable(page, url, *, max_tries=4, min_content=500, wait=3):
    """导航并使页面稳定。BOSS 反爬会对自动化浏览器间歇性返回空壳页面
    （`<html><head></head><body></body></html>` 仅 ~39 字节，URL 也可能是 about:blank）。
    这里在拿到真实内容前自动重试，避免登录/沟通时停在空白页。"""
    for attempt in range(max_tries):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
        except Exception as e:
            log('⚠️', f'导航第 {attempt + 1} 次失败：{str(e)[:60]}，重试…')
            time.sleep(2)
            continue
        time.sleep(wait)
        cur = (page.url or '').strip().lower()
        # 空白/非法页（about:blank、data: 等）：直接重试
        if cur.startswith(('about:', 'data:')) or not cur.startswith('http'):
            log('⚠️', f'第 {attempt + 1} 次命中空白页（{cur[:40]}），重试…')
            time.sleep(2)
            continue
        try:
            blen = len(page.content() or '')
        except Exception:
            blen = float('inf')  # 页面持续导航 → 视为有真实内容
        if blen >= min_content:
            return True
        log('⚠️', f'第 {attempt + 1} 次命中反爬空壳（len={blen if blen != float("inf") else "navigating"}），重试…')
        time.sleep(2)
    return False


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
                expected = {
                    "recruiterName": str(body.get('recruiterName') or ''),
                    "company": str(body.get('company') or ''),
                    "jobTitle": str(body.get('jobTitle') or ''),
                }
                resume_images = body.get('resumeImages') or []
                mode = str(body.get('mode') or 'auto')
                reply_text = str(body.get('replyText') or '')
                if not job_id:
                    return self._send(400, {"ok": False, "error": "缺少 jobId"})
                if not greeting:
                    return self._send(400, {"ok": False, "error": "缺少 greeting", "code": 400})
                result = chat_greeting(job_id, greeting, os_name, send_resume_image, send_online_resume,
                                       expected, resume_images, mode, reply_text)
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
        "playwright": False,
        "kernel": "none",
        "kernelPath": "",
        "kernelMessage": "",
        "cookies": COOKIE_FILE.exists(),
        "cookieCount": 0,
        "loggedIn": False,
        "message": "",
    }
    if COOKIE_FILE.exists():
        try:
            with open(COOKIE_FILE, encoding='utf-8') as f:
                cookies = json.load(f).get('cookies', [])
                info["cookieCount"] = len(cookies)
                # 真实登录态：BOSS 的 wt2 鉴权 token（其余匿名 cookie 不等于已登录）
                info["loggedIn"] = any(
                    str(c.get('name', '')).lower() == 'wt2' and c.get('value')
                    for c in cookies
                )
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
