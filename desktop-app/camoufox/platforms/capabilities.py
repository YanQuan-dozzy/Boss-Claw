#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BossClaw 隐身引擎 —— 平台能力矩阵（对齐 BossHunter `collection/capabilities.py`）
====================================================================
BossHunter 的核心贡献之一：把「某个平台到底支持哪些动作」显式声明成一张**能力表**，
所有调用方（服务端分派、UI 展示、安全门禁）都通过 `platform_supports()` 查询，
而不是靠散落各处的 `if platform == 'boss'` 判断。

本表声明的是**当前代码事实**，不夸大：
  - collect  ：隐身采集（搜索列表 + 详情 JD）
  - score    ：AI 评分（渲染层 analyzeJob 全平台通用）
  - greet    ：招呼语生成（渲染层 greetings.ts 全平台通用）
  - deliver  ：自动投递（各平台 deliver() 已实现）
  - attach   ：投递时补发简历附件/在线简历（**仅 BOSS** —— 其余平台 deliver()
               忽略 sendResumeImage/sendOnlineResume，属实现事实，不得虚报）
  - monitor  ：HR 回复监听（**当前未实现**，四个平台都不含此能力）

投递语义另表 `PLATFORM_DELIVERY_KIND`，与 TS 侧 `PlatformMeta.deliveryKind` 同源：
  chat（BOSS 聊天文字气泡）/ greet_auto（猎聘 App 预设招呼语）/ resume（投递简历按钮）
"""
from __future__ import annotations

# ============================================================
# 动作能力矩阵
# ============================================================
PLATFORM_CAPABILITIES: dict[str, frozenset] = {
    # BOSS 是唯一具备「附件/在线简历补发」的通道（webview 官方接口链路）
    'boss': frozenset({'collect', 'score', 'greet', 'deliver', 'attach'}),
    'liepin': frozenset({'collect', 'score', 'greet', 'deliver'}),
    'zhaopin': frozenset({'collect', 'score', 'greet', 'deliver'}),
    'job51': frozenset({'collect', 'score', 'greet', 'deliver'}),
}

# 已知能力全集（UI 可据此列举，避免各处硬编码字符串）
ALL_CAPABILITIES: tuple = ('collect', 'score', 'greet', 'deliver', 'attach', 'monitor')

# ============================================================
# 投递动作语义
# ============================================================
PLATFORM_DELIVERY_KIND: dict[str, str] = {
    'boss': 'chat',
    'liepin': 'greet_auto',
    'zhaopin': 'resume',
    'job51': 'resume',
}


def platform_supports(platform: str, capability: str) -> bool:
    """平台是否支持指定动作能力（未注册平台一律 False —— 不臆测）。"""
    caps = PLATFORM_CAPABILITIES.get(str(platform or '').strip().lower())
    return bool(caps) and str(capability) in caps


def delivery_kind(platform: str) -> str:
    """平台投递动作语义；未知平台回退 chat（与 TS 侧 resolvePlatform 回退 boss 一致）。"""
    return PLATFORM_DELIVERY_KIND.get(str(platform or '').strip().lower(), 'chat')


def capabilities_payload(platforms=None) -> dict:
    """能力矩阵 JSON（供 `/platforms` 端点与设置页展示；顺序稳定便于快照对比）。"""
    ids = tuple(platforms) if platforms else tuple(PLATFORM_CAPABILITIES)
    return {
        'capabilities': {
            pid: sorted(PLATFORM_CAPABILITIES.get(pid, frozenset())) for pid in ids
        },
        'deliveryKind': {pid: delivery_kind(pid) for pid in ids},
        'allCapabilities': list(ALL_CAPABILITIES),
    }
