#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BossClaw 隐身引擎 —— 多平台断点续采进度存储
====================================================================
对齐 BossHunter 的**词级断点**口径（`get_collected_combos` / `mark_combo_collected`），
用 Boss-claw 的零依赖方式实现：JSON 落盘 + 原子写。

为什么只做词级、不做页级（重要，勿随手加回）
-------------------------------------------
BossHunter 的页级断点是**建立在「逐条落库」之上的**：每采到一个岗位就立刻
`insert_job_if_new` 写进 SQLite，所以「页级断点 + 崩溃」不会丢数据。

Boss-claw 的采集是**整批返回**架构：Python 侧把一轮所有岗位收集到内存，
通过 `/search` 一次性返回给渲染层入库（无中间落库点）。在这个架构下：
  - 若中途推进页级断点、随后崩溃或命中风控 → 前面已采的页随进程一起丢掉，
    下次却从下一页续采 → **静默丢岗位**（比重复采集严重得多）。
  - 若中途中断就清除页级断点 → 页级续采永远不会生效，等价于没有。
因此 Boss-claw 只实现**安全的词级断点**：只有「整轮完整成功返回」才标记完成，
风控/异常一律清除该组合断点（下次重头采，宁重复不遗漏）。

语义
----
- `completed_combo(platform, city, keyword)`：TTL 窗口内整轮采完过 → 跳过（不再打开搜索页）。
- `mark_combo_done(...)`：整轮成功返回后调用（唯一推进点）。
- `clear_combo(...)`：命中风控/环境异常时调用 → 下次重头采。
- `force=True`（「定向重新采集」语义）：忽略断点，强制重采。
- TTL 默认 24h，可用 `resume_ttl_hours`（1~720）或环境变量覆盖。

存储：`~/.bossclaw/collection-progress.json`
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

DEFAULT_TTL_HOURS = 24
MIN_TTL_HOURS = 1
MAX_TTL_HOURS = 720

PROGRESS_VERSION = 1


def progress_file() -> Path:
    """进度文件路径（与 Cookie 同目录，便于用户自查与清理）。"""
    base = Path(os.environ.get('BOSSCLAW_DATA_DIR') or (Path.home() / '.bossclaw'))
    try:
        base.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    return base / 'collection-progress.json'


def combo_key(platform: str, city: str, keyword: str) -> str:
    """断点最小单元 = 平台 × 城市 × 关键词。"""
    return '{0}|{1}|{2}'.format(
        str(platform or '').strip().lower(),
        str(city or '').strip(),
        str(keyword or '').strip(),
    )


def normalize_ttl_hours(raw: Any) -> int:
    """TTL 归一化：`0 / 空 / 非法` 一律回落 24（与 BossHunter 口径一致 —— 0 不表示「禁用」，
    要强制重采请走 `force=True`），有效值夹在 1~720 小时。"""
    try:
        value = int(raw or DEFAULT_TTL_HOURS)
    except (TypeError, ValueError):
        return DEFAULT_TTL_HOURS
    return max(MIN_TTL_HOURS, min(value, MAX_TTL_HOURS))


def ttl_from_config(config: Any, platform: str) -> int:
    """读该平台 `resume_ttl_hours`：platforms.<p>.search → platforms.<p> → search。"""
    cfg = config if isinstance(config, dict) else {}
    platforms = cfg.get('platforms')
    node: dict = {}
    if isinstance(platforms, dict) and isinstance(platforms.get(platform), dict):
        pf = platforms[platform]
        node = pf.get('search') if isinstance(pf.get('search'), dict) else pf
    if not isinstance(node, dict):
        node = {}
    if 'resume_ttl_hours' in node:
        return normalize_ttl_hours(node.get('resume_ttl_hours'))
    search = cfg.get('search')
    if isinstance(search, dict) and 'resume_ttl_hours' in search:
        return normalize_ttl_hours(search.get('resume_ttl_hours'))
    return normalize_ttl_hours(os.environ.get('BOSSCLAW_RESUME_TTL_HOURS') or DEFAULT_TTL_HOURS)


class ProgressStore:
    """断点续采进度（进程内加锁；同一数据文件可被多进程读取，写用原子替换）。"""

    def __init__(self, path: Path | None = None, ttl_hours: int = DEFAULT_TTL_HOURS):
        self._path = Path(path) if path else progress_file()
        self._ttl_hours = normalize_ttl_hours(ttl_hours)
        self._lock = threading.RLock()
        self._combos: dict = {}
        self._loaded = False

    # ---------------- 内部 ----------------
    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            payload = json.loads(self._path.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError, ValueError):
            payload = {}
        combos = payload.get('combos') if isinstance(payload, dict) else None
        self._combos = combos if isinstance(combos, dict) else {}

    def _flush(self) -> None:
        """原子写：临时文件 + os.replace，避免中断留下半截 JSON。"""
        payload = {'version': PROGRESS_VERSION, 'updatedAt': time.time(), 'combos': self._combos}
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix='.progress-', suffix='.tmp', dir=str(self._path.parent))
            try:
                with os.fdopen(fd, 'w', encoding='utf-8') as fh:
                    json.dump(payload, fh, ensure_ascii=False, indent=2)
                os.replace(tmp, self._path)
            finally:
                if os.path.exists(tmp):
                    try:
                        os.unlink(tmp)
                    except OSError:
                        pass
        except OSError:
            # 进度落盘失败不得影响采集主流程（断点续采是增强，不是前置条件）
            pass

    def _valid(self, key: str, *, fresh: bool) -> dict | None:
        entry = self._combos.get(key)
        if not isinstance(entry, dict):
            return None
        try:
            at_val = float(entry.get('at'))
        except (TypeError, ValueError):
            return None
        if time.time() - at_val > self._ttl_hours * 3600:
            if fresh:
                self._combos.pop(key, None)
            return None
        return entry

    # ---------------- 对外 ----------------
    @property
    def ttl_hours(self) -> int:
        return self._ttl_hours

    @property
    def path(self) -> Path:
        return self._path

    def completed_combo(self, platform: str, city: str, keyword: str) -> bool:
        """TTL 窗口内是否已整轮采完（→ 任务级跳过）。"""
        with self._lock:
            self._load()
            entry = self._valid(combo_key(platform, city, keyword), fresh=True)
            return bool(entry and entry.get('done'))

    def mark_combo_done(self, platform: str, city: str, keyword: str,
                        pages: int = 0, count: int = 0) -> None:
        """整轮成功返回后推进断点（唯一推进点）。"""
        with self._lock:
            self._load()
            self._combos[combo_key(platform, city, keyword)] = {
                'done': True,
                'pages': max(0, int(pages or 0)),
                'count': max(0, int(count or 0)),
                'at': time.time(),
            }
            self._flush()

    def clear_combo(self, platform: str, city: str, keyword: str) -> None:
        """清除单个组合断点（风控/异常后必须清除 → 下次重头采，宁重复不遗漏）。"""
        with self._lock:
            self._load()
            if self._combos.pop(combo_key(platform, city, keyword), None) is not None:
                self._flush()

    def clear_platform(self, platform: str) -> int:
        """清除某平台全部断点（设置页「重新采一遍」），返回清除条数。"""
        prefix = '{0}|'.format(str(platform or '').strip().lower())
        with self._lock:
            self._load()
            keys = [k for k in self._combos if str(k).startswith(prefix)]
            for key in keys:
                self._combos.pop(key, None)
            if keys:
                self._flush()
            return len(keys)

    def clear_all(self) -> int:
        """清除全部断点，返回清除条数。"""
        with self._lock:
            self._load()
            removed = len(self._combos)
            if removed:
                self._combos = {}
                self._flush()
            return removed

    def prune(self, keywords: list | None = None) -> int:
        """清理超 TTL 条目（可选按关键词白名单收窄），返回清理条数。"""
        with self._lock:
            self._load()
            allow = {str(k).strip() for k in (keywords or []) if str(k).strip()} or None
            removed = 0
            for key in list(self._combos):
                parts = str(key).split('|')
                keyword = parts[2] if len(parts) > 2 else ''
                if allow is not None and keyword and keyword not in allow:
                    continue
                if self._valid(key, fresh=False) is None:
                    self._combos.pop(key, None)
                    removed += 1
            if removed:
                self._flush()
            return removed

    def snapshot(self) -> dict:
        """只读快照（诊断 / 设置页展示）。"""
        with self._lock:
            self._load()
            return {
                'version': PROGRESS_VERSION,
                'ttlHours': self._ttl_hours,
                'path': str(self._path),
                'comboCount': len(self._combos),
                'combos': dict(self._combos),
            }
