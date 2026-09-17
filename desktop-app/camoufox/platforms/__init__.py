#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BossClaw 隐身引擎 —— 多平台模块注册表与统一分派
==========================================
BOSS 直聘 之外的新增平台：猎聘 liepin / 智联招聘 zhaopin / 前程无忧 51job。
各平台模块实现统一接口：
  - search_jobs(query, city, pages, os_name) -> {ok, code, message, jobs}
  - deliver(job, greeting, os_name, send_resume_image, send_online_resume,
            expected, resume_images, mode, reply_text) -> {ok, sent, code, message, ...}
  - do_login(timeout, os_name) -> {ok, loggedIn, code, message}

BOSS 平台仍由 camoufox_server.py 原有逻辑处理（兼容回归）。

分层（对齐 BossHunter `collection/`）
------------------------------------
    models.py       平台中立数据模型 JobCandidate（统一出口）
    capabilities.py 平台能力矩阵（collect / score / greet / deliver / attach）
    progress.py     断点续采进度存储（词级断点，TTL 24h）
    base.py         CollectorBase：搜索 / 投递 / 登录三段骨架的唯一实现
    registry.py     平台 → 采集器 注册表（新增平台只改这里）
    <platform>.py   平台差异声明（常量表 / JS 选择器 / 接口解析）

本层只做**分派与能力查询**，不含平台业务逻辑。

新增平台检查清单
----------------
1. 在 `<platform>.py` 中继承 `CollectorBase` 并声明差异；
2. 在 `registry.build_default_registry()` 里登记实例；
3. 在 `capabilities.PLATFORM_CAPABILITIES` / `PLATFORM_DELIVERY_KIND` 补一行；
4. TS 侧 `src/lib/bossclaw/platforms.ts` 的 `PLATFORM_META` 补一行（同源口径）。
"""
from . import capabilities, models, progress, registry
from .capabilities import (
    PLATFORM_CAPABILITIES,
    PLATFORM_DELIVERY_KIND,
    capabilities_payload,
    delivery_kind,
    platform_supports,
)

# 已知平台全集（含 BOSS）
PLATFORMS = registry.ALL_PLATFORMS


def is_platform(p: str) -> bool:
    return str(p or '').strip().lower() in PLATFORMS


def supports(platform: str, capability: str) -> bool:
    """平台能力查询（唯一权威 = capabilities.PLATFORM_CAPABILITIES）。"""
    return platform_supports(platform, capability)


def search_jobs(platform: str, query: str, city: str, pages: int = 1, os_name: str | None = None,
                criteria: dict | None = None, force: bool = False,
                config: dict | None = None) -> dict:
    """criteria = 设置页「基础求职条件」（全平台共用：城市/薪资/求职类型/学历/经验/公司规模），
    由 filters.build_filter_params 翻译成各平台自身筛选参数（见 filters.py 能力表）。

    force=True 时忽略断点续采、强制重采（「定向重新采集」语义）。
    """
    p = str(platform or '').strip().lower()
    if not registry.registry.has(p):
        return {"ok": False, "code": 400, "message": f"不支持的平台：{platform}", "jobs": []}
    return registry.registry.get(p).search_jobs(query, city, pages, os_name, criteria, force, config)


def deliver(platform: str, job: dict, greeting: str, os_name: str | None = None,
            send_resume_image: bool = False, send_online_resume: bool = False,
            expected: dict | None = None, resume_images: list | None = None,
            mode: str = 'auto', reply_text: str | None = None) -> dict:
    p = str(platform or '').strip().lower()
    if not registry.registry.has(p):
        return {"ok": False, "sent": False, "code": 400, "message": f"不支持的平台：{platform}"}
    return registry.registry.get(p).deliver(
        job, greeting, os_name, send_resume_image, send_online_resume,
        expected, resume_images, mode, reply_text)


def do_login(platform: str, timeout: int = 180, os_name: str | None = None) -> dict:
    p = str(platform or '').strip().lower()
    if not registry.registry.has(p):
        return {"ok": False, "code": 400, "message": f"不支持的平台：{platform}"}
    return registry.registry.get(p).do_login(timeout, os_name)


# ============================================================
# 能力 / 进度：供服务端端点与设置页展示
# ============================================================
def platform_capabilities(platforms: list | None = None) -> dict:
    """平台能力矩阵 JSON（`/platforms` 端点）。"""
    return capabilities_payload(platforms or PLATFORMS)


def collection_progress(platform: str | None = None, config: dict | None = None) -> dict:
    """断点续采进度快照；指定 platform 时只看该平台。ttlHours 按实际配置回显（否则为默认 24）。"""
    ttl = progress.ttl_from_config(config, platform or '') if config else progress.DEFAULT_TTL_HOURS
    store = progress.ProgressStore(ttl_hours=ttl)
    snap = store.snapshot()
    if platform:
        prefix = f"{str(platform).strip().lower()}|"
        snap['combos'] = {k: v for k, v in snap['combos'].items() if str(k).startswith(prefix)}
        snap['comboCount'] = len(snap['combos'])
    return snap


def clear_collection_progress(platform: str | None = None) -> dict:
    """清除断点续采进度（指定平台 / 全部），返回清除条数。"""
    store = progress.ProgressStore()
    removed = store.clear_platform(platform) if platform else store.clear_all()
    return {"ok": True, "removed": removed}
