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
"""
from . import liepin, zhaopin, job51

PLATFORMS = ('boss', 'liepin', 'zhaopin', 'job51')
MODULES = {
    'liepin': liepin,
    'zhaopin': zhaopin,
    'job51': job51,
}


def is_platform(p: str) -> bool:
    return str(p or '').strip().lower() in PLATFORMS


def search_jobs(platform: str, query: str, city: str, pages: int = 1, os_name: str | None = None,
                criteria: dict | None = None) -> dict:
    """criteria = 设置页「基础求职条件」（全平台共用：城市/薪资/求职类型/学历/经验/公司规模），
    由 filters.build_filter_params 翻译成各平台自身筛选参数（见 filters.py 能力表）。"""
    mod = MODULES.get(str(platform or '').strip().lower())
    if mod is None:
        return {"ok": False, "code": 400, "message": f"不支持的平台：{platform}", "jobs": []}
    return mod.search_jobs(query, city, pages, os_name, criteria)


def deliver(platform: str, job: dict, greeting: str, os_name: str | None = None,
            send_resume_image: bool = False, send_online_resume: bool = False,
            expected: dict | None = None, resume_images: list | None = None,
            mode: str = 'auto', reply_text: str | None = None) -> dict:
    mod = MODULES.get(str(platform or '').strip().lower())
    if mod is None:
        return {"ok": False, "sent": False, "code": 400, "message": f"不支持的平台：{platform}"}
    return mod.deliver(job, greeting, os_name, send_resume_image, send_online_resume,
                       expected, resume_images, mode, reply_text)


def do_login(platform: str, timeout: int = 180, os_name: str | None = None) -> dict:
    mod = MODULES.get(str(platform or '').strip().lower())
    if mod is None:
        return {"ok": False, "code": 400, "message": f"不支持的平台：{platform}"}
    return mod.do_login(timeout, os_name)
