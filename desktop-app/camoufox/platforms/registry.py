#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BossClaw 隐身引擎 —— 平台采集器注册表
====================================================================
对齐 BossHunter `collection/registry.py`：平台 → 采集器 的**唯一登记处**。

改造前 `platforms/__init__.py` 用 `MODULES = {...}` 硬编码模块 + 服务端
`if platform == 'boss'` 分叉 5 处；现在统一走本注册表查询，
新增平台只需在 `DEFAULT_COLLECTORS` 加一行（无需改服务端分派）。

BOSS 说明
---------
BOSS 直聘的采集/投递**不在本包内实现**（在 `camoufox_server.py`，走 webview /
官方接口 / searchUrl.ts 链路，属既有兼容回归路径）。这里只在能力表中登记 BOSS 的
能力与投递语义，**不做**运行时重定向 —— 避免动到已验证的 BOSS 链路。
"""
from __future__ import annotations

from typing import Any

from .base import CollectorBase
from .capabilities import capabilities_payload, platform_supports


class CollectorRegistry:
    """平台采集器注册表（工厂式：`get()` 返回实例，可被服务端直接调用）。"""

    def __init__(self, factories: dict | None = None):
        self._factories: dict = dict(factories or {})

    def register(self, platform: str, factory: Any) -> None:
        """登记平台采集器：可传实例或返回实例的可调用对象。"""
        self._factories[str(platform or '').strip().lower()] = factory

    def has(self, platform: str) -> bool:
        return str(platform or '').strip().lower() in self._factories

    def get(self, platform: str) -> CollectorBase:
        key = str(platform or '').strip().lower()
        factory = self._factories.get(key)
        if factory is None:
            raise ValueError(f'未注册的采集平台：{platform}')
        return factory() if callable(factory) else factory

    def platforms(self) -> tuple:
        """已注册（可实际采集）的平台，顺序稳定。"""
        return tuple(self._factories)

    def supports(self, platform: str, capability: str) -> bool:
        """能力查询（转发到 capabilities 矩阵，保持单一权威）。"""
        return platform_supports(platform, capability)

    def capabilities(self) -> dict:
        return capabilities_payload(self.platforms())


def build_default_registry() -> CollectorRegistry:
    """内置三平台（BOSS 之外）注册表。延迟导入以避免循环依赖。"""
    from . import job51, liepin, zhaopin
    return CollectorRegistry({
        'liepin': liepin._COLLECTOR,
        'zhaopin': zhaopin._COLLECTOR,
        'job51': job51._COLLECTOR,
    })


# 进程级默认注册表（server 分派与能力查询共用）
registry = build_default_registry()

# 已知平台全集（含 BOSS —— 由 camoufox_server 处理，不在本注册表内）
ALL_PLATFORMS: tuple = ('boss', 'liepin', 'zhaopin', 'job51')

# BOSS 是否由本注册表提供采集实现（False：走 camoufox_server 既有链路）
BOSS_HANDLED_BY_SERVER = True
