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
import tempfile
import threading
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
        # H-9：字段缺失不再抛 KeyError 穿透整链路（search_jobs/deliver/do_login → HTTP 500）；
        # 缺关键字段的条目直接跳过（降级为空/部分 Cookie 继续，而非整条链路硬失败）。
        if not isinstance(c, dict):
            continue
        name, value, domain = c.get("name"), c.get("value"), c.get("domain")
        if not name or not value or not domain:
            log('⚠️', '跳过字段缺失的 Cookie（%s）：name=%r domain=%r' % (platform, name, domain))
            continue
        cookie = {
            "name": name, "value": value,
            "domain": domain, "path": c.get("path", "/"),
        }
        expires = c.get("expires", -1)
        try:
            expires = float(expires)
        except (TypeError, ValueError):
            expires = -1.0
        # 兼容毫秒时间戳：直译会被当成「公元五万年后到期」的永久 Cookie，
        # 反过来把服务端刚下发的新值挡住（会话从此再也刷新不了）。
        if expires > 1e12:
            expires /= 1000.0
        # 已过期的条目不再注入：它们只会陪跑，且在平台上看起来像「有会话但失效」。
        if 0 < expires <= time.time():
            log('⚠️', f'跳过已过期的 Cookie（{platform}）：{name}')
            continue
        if expires > 0:
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


def clear_session(platform: str = 'boss') -> bool:
    """退出登录 / 清空数据：Cookie 文件 + 该平台持久 profile 一并清除。

    只删 Cookie 是不够的——profile 里还留着 localStorage 与浏览器自身的会话存储，
    下次打开会被平台认成「仍然登录」，导致「退出登录后依旧登录」。
    固定指纹（identity 文件）**刻意保留**：换指纹会让平台重新判定设备异常。

    若浏览器仍在运行导致目录删不掉，则留下 `.logout-pending` 标记，
    由下一次 `_acquire_profile` 在持有独占锁时补删（见该函数）。
    """
    ok = clear_cookies(platform)
    prof = profile_dir(platform)
    marker = _pending_clear_file(platform)
    if prof.exists():
        try:
            shutil.rmtree(prof, ignore_errors=False)
            log('🗑️', f'已清除 {platform} 浏览器 profile')
            ok = True
        except Exception as e:
            log('⚠️', f'清除 {platform} 浏览器 profile 失败（浏览器可能仍在运行）：{str(e)[:80]}')
            try:
                _PROFILE_ROOT.mkdir(parents=True, exist_ok=True)
                marker.write_text(str(time.time()), encoding='utf-8')
            except Exception:
                pass
            return ok
    try:
        marker.unlink(missing_ok=True)
    except Exception:
        pass
    return ok


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


# ============================================================
# 浏览器身份（固定指纹）与 profile 持久化
# ============================================================
# 说明见 `open_browser` 文档字符串：指纹与 profile 都必须跨次稳定，否则平台的
# 会话令牌会因「指纹变了」被判定失效（BOSS 文案：身份验证失效）。
_PROFILE_ROOT = DATA_DIR / 'camoufox-profiles'

# 每个平台一把进程内锁：同一 profile 目录不能被两个 Gecko 实例同时打开。
# 拿不到锁的调用方降级到一次性目录（见 open_browser）。
_PROFILE_LOCKS: dict = {}
_PROFILE_LOCKS_GUARD = threading.Lock()

# 指纹生成串行化：fpgen 首次要下载模型，耗时且不该并发跑两份
_IDENTITY_LOCK = threading.Lock()


class _LaunchError(RuntimeError):
    """仅表示**浏览器启动阶段**失败（区别于调用方在 with 体内的异常）。"""


def _platform_key(platform: str = 'boss') -> str:
    p = str(platform or 'boss').strip().lower()
    return p if p in PLATFORMS else 'boss'


def normalize_os(os_name: str | None = None) -> str:
    """把目标 OS 归一成 Camoufox 的三个取值，缺省按宿主系统定。

    「未指定」不能留成随机：前端部分调用点传 `cfg.camoufox?.os`（可能 undefined）、
    部分不传，若两者解析成两套身份，同一账号会在两套指纹之间来回切，
    平台侧看到的就是「设备环境反复变化」——正是要消除的那种可疑信号。
    """
    v = str(os_name or '').strip().lower()
    if v in ('windows', 'macos', 'linux'):
        return v
    if v in ('win', 'win32', 'win64'):
        return 'windows'
    if v in ('mac', 'darwin', 'osx'):
        return 'macos'
    if v:
        return v
    if sys.platform.startswith('win'):
        return 'windows'
    if sys.platform == 'darwin':
        return 'macos'
    return 'linux'


def profile_dir(platform: str = 'boss') -> Path:
    """平台级持久 profile 目录（保留 localStorage / IndexedDB 等非 Cookie 会话状态）。"""
    return _PROFILE_ROOT / _platform_key(platform)


def _pending_clear_file(platform: str = 'boss') -> Path:
    """「退出登录时浏览器还开着、profile 没删掉」的补删标记。"""
    return _PROFILE_ROOT / f'.{_platform_key(platform)}.logout-pending'


def identity_file(platform: str = 'boss', os_name: str | None = None) -> Path:
    """固定指纹缓存文件。OS 参与命名：切换目标系统应换一套指纹，而不是混用。"""
    return DATA_DIR / f'camoufox-identity-{_platform_key(platform)}-{normalize_os(os_name)}.json'


def _write_json_atomic(path: Path, payload) -> None:
    """原子写：先写 tmp 再 replace，避免中途崩溃留下半个 JSON 被下次读成「有效身份」。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, ensure_ascii=False)
    os.replace(tmp, path)


def _read_identity(f: Path) -> dict | None:
    if not f.exists():
        return None
    try:
        with open(f, encoding='utf-8') as fh:
            fp = json.load(fh)
        if isinstance(fp, dict) and isinstance(fp.get('navigator'), dict):
            return fp
        log('⚠️', f'浏览器身份文件格式异常，重新生成：{f.name}')
    except Exception as e:
        log('⚠️', f'读取浏览器身份失败，重新生成：{str(e)[:80]}')
    return None


def load_identity(platform: str = 'boss', os_name: str | None = None) -> dict | None:
    """读取（首次则生成并落盘）该平台固定的浏览器指纹；失败返回 None（沿用随机身份）。

    生成要调用 fpgen（首次会下载指纹模型，可能耗时数十秒），因此整体加锁 + 二次检查：
    预热线程与首个真实请求撞上时，只生成一次，不会各自写出一份不同身份。
    """
    f = identity_file(platform, os_name)
    cached = _read_identity(f)
    if cached is not None:
        return cached
    with _IDENTITY_LOCK:
        cached = _read_identity(f)  # 等锁期间别人可能已经生成好了
        if cached is not None:
            return cached
        try:
            from camoufox.fingerprints import generate_fingerprint
            fp = generate_fingerprint(os=normalize_os(os_name))
            if not isinstance(fp, dict) or not isinstance(fp.get('navigator'), dict):
                return None
            _write_json_atomic(f, fp)
            log('🪪', f'[{_platform_key(platform)}] 已生成并固定浏览器身份（{f.name}）')
            return fp
        except Exception as e:
            # 例如 fpgen 模型缺失 / 离线导致下载失败：本次沿用 Camoufox 随机身份，
            # 不阻断业务（只是这一轮仍可能触发平台重新验证）。
            log('⚠️', f'[{_platform_key(platform)}] 生成固定浏览器身份失败（本次沿用随机身份）：{str(e)[:120]}')
            return None


def _acquire_profile(platform: str) -> tuple:
    """尝试独占平台 profile：返回 (lock, profile_path, temp_dir)。

    拿不到锁 → lock=None、temp_dir=一次性目录（调用方负责删除）。
    """
    key = _platform_key(platform)
    with _PROFILE_LOCKS_GUARD:
        lock = _PROFILE_LOCKS.setdefault(key, threading.Lock())
    if lock.acquire(blocking=False):
        p = profile_dir(key)
        marker = _pending_clear_file(key)
        if marker.exists():
            # 上次退出登录时浏览器还开着，profile 没能删掉。此刻持有独占锁，
            # 目录必然无人占用 —— 补删，否则「退出登录」会一直不生效。
            shutil.rmtree(p, ignore_errors=True)
            try:
                marker.unlink()
            except Exception:
                pass
            log('🗑️', f'[{key}] 已补清上次未完成的退出登录残留 profile')
        p.mkdir(parents=True, exist_ok=True)
        return lock, str(p), None
    _PROFILE_ROOT.mkdir(parents=True, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix=f'bossclaw-{key}-', dir=str(_PROFILE_ROOT))
    log('ℹ️', f'[{key}] profile 正被其它任务占用，改用一次性 profile（固定指纹不变）')
    return None, tmp, tmp


@contextmanager
def _browser_page(kwargs: dict):
    """启动浏览器并 yield 一个 page；**只有启动阶段**失败才抛 `_LaunchError`。"""
    from camoufox.sync_api import Camoufox
    cm = Camoufox(**kwargs)
    try:
        browser = cm.__enter__()
    except BaseException as exc:  # noqa: BLE001 - 启动失败一律转成可降级的类型
        raise _LaunchError(str(exc)) from exc
    try:
        pages = getattr(browser, 'pages', None)
        page = pages[0] if pages else browser.new_page()
        yield page
    except BaseException:
        cm.__exit__(*sys.exc_info())
        raise
    else:
        cm.__exit__(None, None, None)


@contextmanager
def open_browser(os_name: str | None = None, headless: bool = False, platform: str = 'boss'):
    """按检测到的内核打开浏览器，yield page；退出时自动关闭。仅 Camoufox 原生内核可用。

    内核缺失时显式抛错（fail-safe）：不静默回退到 Playwright 自带 Chromium ——
    BOSS 反爬对该内核返回空壳页，静默回退只会把「内核缺失」伪装成「被反爬拦截」误导排查。
    （P6-05：原 15 个系统浏览器候选路径 + stealth_init_script 为死代码，已删除。）

    会话稳定性（「身份验证失效」根因修复）
    ------------------------------------
    原实现每次调用都 new 一个**一次性** profile，且 Camoufox 默认每启动一次就由 fpgen
    随机抽一套指纹。BOSS 的会话令牌（`__zp_stoken__` 等）与浏览器指纹绑定：同一份登录
    Cookie 搬到一套全新指纹下，服务端会判定「身份验证失效」——现象就是「扫码提示登录
    成功，一进自动沟通就要求重新验证」，而且永远好不了（每次重试指纹又是新的）。
    修复两点：
      1. 指纹首次生成后落盘复用（`camoufox-identity-{platform}-{os}.json`）；
      2. profile 按平台持久化（`camoufox-profiles/{platform}`），保留 localStorage /
         IndexedDB 等非 Cookie 会话状态。

    同一平台已有浏览器在跑（如常驻 AI 跟聊）时，profile 目录会被 Gecko 独占锁住，
    此时自动降级为一次性目录 + **同一套固定指纹**：登录态仍由 Cookie 注入保证，
    只是丢掉浏览器本地存储（不影响登录与投递）。
    """
    kernel = detect_kernel()
    if kernel["kind"] != "camoufox":
        raise RuntimeError(kernel.get("message") or "隐身引擎未就绪：请先安装 Camoufox 内核")

    key = _platform_key(platform)
    base: dict = {"humanize": True, "block_images": False}
    identity = load_identity(key, os_name)
    if identity:
        # 指纹自带 OS，不能再传 os（两者不一致会让 Camoufox 内部形象自相矛盾）
        base["fingerprint"] = identity
    elif os_name:
        base["os"] = normalize_os(os_name)
    if headless:
        base["headless"] = "virtual"

    lock, profile, temp_dir = _acquire_profile(key)
    try:
        kwargs = {**base, "persistent_context": True, "user_data_dir": profile}
        try:
            with _browser_page(kwargs) as page:
                yield page
        except _LaunchError as e:
            # 持久 profile 打不开（上次异常退出留下 lock、目录损坏、磁盘权限等）
            # 不能让整条链路失败：退回一次性 profile，指纹仍是固定的那套。
            if temp_dir is not None:
                raise RuntimeError(str(e.__cause__ or e)) from e.__cause__
            log('⚠️', f'[{key}] 持久 profile 启动失败（{str(e.__cause__ or e)[:80]}），改用临时 profile')
            _PROFILE_ROOT.mkdir(parents=True, exist_ok=True)
            fallback_tmp = tempfile.mkdtemp(prefix=f'bossclaw-{key}-', dir=str(_PROFILE_ROOT))
            try:
                with _browser_page({**base, "persistent_context": True, "user_data_dir": fallback_tmp}) as page:
                    yield page
            finally:
                shutil.rmtree(fallback_tmp, ignore_errors=True)
    finally:
        if lock is not None:
            lock.release()
        if temp_dir is not None:
            shutil.rmtree(temp_dir, ignore_errors=True)
    return


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
        except Exception as e:
            # M-16：取页面内容失败**不能**当作「内容充足」直接返回成功（原实现 blen=float('inf')），
            # 多为页面仍在导航或被反爬中断 → 按未稳定处理并重试。
            log('⚠️', f'第 {attempt + 1} 次读取页面内容失败：{str(e)[:60]}，重试…')
            time.sleep(2)
            continue
        if blen >= min_content:
            return True
        log('⚠️', f'第 {attempt + 1} 次命中反爬空壳（len={blen}），重试…')
        time.sleep(2)
    return False


# ============================================================
# 风控文本 / 外部网申检测（跨平台复用；各平台按需调用）
# ============================================================
# 「访问验证 / 请按住滑块」是 Aliyun WAF 滑块壳页的正文文案（51Job 实测），
# 单靠空壳页长度判定不够——必须能按文案收口，否则会静默空采而不是停止交人工。
RISK_TEXT_RE = re.compile(
    r'安全验证|访问验证|请按住滑块|访问过于频繁|请完成验证|验证码|异常请求|账号异常|操作过于频繁|请稍后再试|'
    r'登录已过期|请重新登录|当前环境异常|系统检测到异常'
)

# 结构化 WAF 标记（Aliyun WAF 滑块壳页正文可能为空，文本词表会漏检；
# 与 get_jobs(Job51.java)::checkAccessVerification 的判定标记同源）
WAF_DOM_PROBE_JS = (
    "() => { try { return !!(document.querySelector('.waf-nc-title')"
    " || document.querySelector('script[name^=\"aliyunwaf_\"]')); } catch (e) { return false; } }"
)

# 投递类平台（智联/51Job）每日上限提示词
DAILY_LIMIT_RE = re.compile(r'今日投递|已达上限|投递上限|投递次数|每日.{0,4}投递|今日.{0,6}限制')


def risk_text_hit(page) -> str:
    """风控检测：页面正文文案 + Aliyun WAF 结构标记，命中返回命中词（无命中返回空串）。"""
    try:
        text = page.evaluate("() => (document.body ? document.body.innerText.slice(0, 4000) : '')") or ''
        m = RISK_TEXT_RE.search(text)
        if m:
            return m.group(0)
    except Exception:
        pass
    try:
        if page.evaluate(WAF_DOM_PROBE_JS):
            return 'aliyun-waf'
    except Exception:
        pass
    return ''
