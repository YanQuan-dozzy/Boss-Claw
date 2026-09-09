#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BossClaw 隐身引擎 —— 平台公共基座（浏览器 / 人类化 / Cookie 按平台持久化）
====================================================================
从 camoufox_server.py 抽取的共享能力，供 BOSS 与 猎聘/智联/51Job 平台模块复用。
仅使用 Camoufox 原生隐身内核（AGENTS.md：本地 Chrome/Edge 不可复用）。

  - open_browser   : 按检测内核打开浏览器（Camoufox 原生内核优先）
  - human_delay/sleep/type_greeting_human : 人类化抖动（只做主动降频，绝不绕过）
  - load/save_cookies(platform) : 登录态按平台独立持久化 ~/.bossclaw/camoufox-cookies-{platform}.json
  - goto_stable    : 反爬空壳页自动重试导航
"""
import json
import os
import random
import re
import shutil
import sys
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

# ============================================================
# 路径与配置
# ============================================================
DATA_DIR = Path.home() / '.bossclaw'
DATA_DIR.mkdir(parents=True, exist_ok=True)

# 平台：boss / liepin / zhaopin / job51（BOSS 为默认兼容路径）
PLATFORMS = ('boss', 'liepin', 'zhaopin', 'job51')


def cookie_file(platform: str = 'boss') -> Path:
    """各平台独立 Cookie 文件：~/.bossclaw/camoufox-cookies-{platform}.json（boss 保持旧路径兼容）。"""
    p = str(platform or 'boss').strip().lower()
    if p == 'boss':
        return DATA_DIR / 'camoufox-cookies.json'
    return DATA_DIR / f'camoufox-cookies-{p}.json'


# 可复用的系统浏览器内核候选路径（Windows 优先，macOS/Linux 兜底；仅检测用，不参与回退）
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
# ============================================================
def human_delay(seconds: float, jitter_ratio: float = 0.35, min_seconds: float = 0.0) -> float:
    """在 base 秒基础上叠加 ±ratio 的随机游走，返回实际需等待的秒数。"""
    base = max(0.0, seconds)
    width = base * jitter_ratio
    return max(min_seconds, base - width + random.random() * width * 2)


def human_sleep(seconds: float, jitter_ratio: float = 0.35, min_seconds: float = 0.0, rng=None):
    """人类化随机关心（对 status 透传时也可传 rng）。"""
    return time.sleep(human_delay(seconds, jitter_ratio, min_seconds))


def type_greeting_human(page, text: str, os_name: str | None = None):
    """真实键盘逐字输入（带随机打字节奏；中文略慢）。os_name 仅保留签名兼容。"""
    for ch in text:
        delay = random.randint(20, 120)
        if ord(ch) > 127:
            delay = random.randint(40, 140)
        page.keyboard.type(ch, delay=delay)
    return True


# ============================================================
# Cookie 管理（按平台独立持久化）
# ============================================================
def load_cookies(platform: str = 'boss') -> list:
    f = cookie_file(platform)
    if not f.exists():
        return []
    try:
        with open(f, encoding='utf-8') as fh:
            auth = json.load(fh)
    except Exception as e:
        log('⚠️', f'读取 Cookie 失败（{platform}）：{e}')
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


def save_cookies(context, platform: str = 'boss') -> int:
    """导出会话 Cookie 回持久化文件（带备份）。"""
    try:
        all_cookies = context.cookies()
    except Exception as e:
        log('⚠️', f'导出 Cookie 失败（{platform}）：{e}')
        return 0
    export = []
    for c in all_cookies:
        export.append({
            "name": c["name"], "value": c["value"], "domain": c["domain"],
            "path": c.get("path", "/"), "expires": c.get("expires", -1),
            "size": len(c.get("value", "")), "httpOnly": c.get("httpOnly", False),
            "secure": c.get("secure", False), "session": c.get("expires", -1) == -1,
        })
    f = cookie_file(platform)
    if f.exists():
        try:
            backup = f.parent / (f.stem + '.backup.json')
            shutil.copy(f, backup)
        except Exception:
            pass
    with open(f, 'w', encoding='utf-8') as fh:
        json.dump({"cookies": export, "origins": []}, fh, ensure_ascii=False, indent=2)
    log('💾', f'Cookie 已持久化（{platform}）：{len(export)} 条 → {f}')
    return len(export)


def clear_cookies(platform: str = 'boss') -> bool:
    f = cookie_file(platform)
    if f.exists():
        try:
            f.unlink()
            log('🗑️', f'已清除 {platform} Cookie')
            return True
        except Exception:
            return False
    return False


# ============================================================
# 内核检测与浏览器启动（仅 Camoufox 原生隐身内核）
# ============================================================
def detect_kernel(force: bool = False) -> dict:
    """检测可用的隐身内核。仅 Camoufox 原生内核可用；系统浏览器不参与回退。"""
    global _KERNEL_CACHE
    if _KERNEL_CACHE and not force:
        return _KERNEL_CACHE
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
    _KERNEL_CACHE = {
        "kind": "none", "path": None, "camoufox": False,
        "message": "隐身引擎未就绪：暂未下载 Camoufox 内核，请安装 Camoufox 原生内核：pip install \"camoufox[geoip]\" && camoufox fetch",
    }
    return _KERNEL_CACHE


def stealth_init_script() -> str:
    """Chromium 系 stealth 初始化脚本（仅当 Camoufox 不可用时的尽力而为路径；BOSS 实测仍需 Camoufox）。"""
    return """
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
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
    try {
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5].map((i) => ({ name: 'Plugin ' + i, filename: 'plugin' + i + '.dll', description: '' })),
      });
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
        with Camoufox(**kwargs) as browser:
            page = browser.new_page()
            yield page
        return

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


def goto_stable(page, url, *, max_tries=4, min_content=500, wait=3):
    """导航并使页面稳定。反爬会对自动化浏览器间歇性返回空壳页，自动重试。"""
    for attempt in range(max_tries):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
        except Exception as e:
            log('⚠️', f'导航第 {attempt + 1} 次失败：{str(e)[:60]}，重试…')
            time.sleep(2)
            continue
        time.sleep(wait)
        cur = (page.url or '').strip().lower()
        if cur.startswith(('about:', 'data:')) or not cur.startswith('http'):
            log('⚠️', f'第 {attempt + 1} 次命中空白页（{cur[:40]}），重试…')
            time.sleep(2)
            continue
        try:
            blen = len(page.content() or '')
        except Exception:
            blen = float('inf')
        if blen >= min_content:
            return True
        log('⚠️', f'第 {attempt + 1} 次命中反爬空壳（len={blen if blen != float("inf") else "navigating"}），重试…')
        time.sleep(2)
    return False


# ============================================================
# 风控文本 / 外部网申检测（跨平台复用；各平台按需调用）
# ============================================================
RISK_TEXT_RE = re.compile(
    r'安全验证|访问过于频繁|请完成验证|验证码|异常请求|账号异常|操作过于频繁|请稍后再试|'
    r'登录已过期|请重新登录|当前环境异常|系统检测到异常'
)

# 投递类平台（智联/51Job）每日上限提示词
DAILY_LIMIT_RE = re.compile(r'今日投递|已达上限|投递上限|投递次数|每日.{0,4}投递|今日.{0,6}限制')


def risk_text_hit(page) -> str:
    """页面正文风控文本检测，命中返回命中词。"""
    try:
        text = page.evaluate("() => (document.body ? document.body.innerText.slice(0, 4000) : '')") or ''
        m = RISK_TEXT_RE.search(text)
        return m.group(0) if m else ''
    except Exception:
        return ''
