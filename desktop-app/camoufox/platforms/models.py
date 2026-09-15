#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BossClaw 隐身引擎 —— 多平台统一数据模型
====================================================================
对齐 BossHunter `collection/models.py`：所有平台采集器产出的岗位都必须收敛成
同一份「平台中立」契约 `JobCandidate`，再由 `to_job_meta()` 转成 Boss-claw 渲染层
既有的 `CamoufoxJob / JobMeta` 结构（字段名保持不变，只做**追加**不改名，避免破坏存量）。

设计要点（照搬 BossHunter 的取舍）
----------------------------------
1. **平台中立**：采集器只填语义字段（title/company/salary/...），不关心下游怎么用；
   平台差异（URL 形态、卡片选择器、鉴权 Cookie）留在各平台模块里。
2. **稳定身份**：`storage_id` 提供跨平台唯一键 —— BOSS 沿用裸 jobId（存量兼容，
   Boss-claw 历史数据的 jobId 就是 BOSS 的），其余平台用 `<platform>:<jobId>`。
3. **招聘类型保守分类**：`classify_recruitment_type()` 只在文本出现**明确**校招/社招
   信号时才下结论，否则 `unknown`；不做猜测（对齐 BossHunter 的 conservative 口径）。
4. **JD 清洗**：只剥离页面来源噪声（「来自 BOSS 直聘」等），不改写 JD 事实。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict
from typing import Any

# 平台枚举（与 camoufox/platforms/common.py、TS platforms.ts 的 JobPlatform 同源）
PLATFORM_IDS = ('boss', 'liepin', 'zhaopin', 'job51')

# ============================================================
# 文本清洗（平台中立）
# ============================================================
# 各平台详情页会往 JD 里塞来源水印，属于噪声而非 JD 事实
_SOURCE_NOISE = (
    re.compile(r'\[\s*岗位(?:kanzhun)?职责\s*\]', re.IGNORECASE),
    re.compile(r'来自\s*(?:BOSS\s*直聘|智联招聘|前程无忧|51job|猎聘)', re.IGNORECASE),
    re.compile(r'(?:本|该)职位(?:信息)?来源(?:于|[:：])\s*(?:BOSS\s*直聘|智联招聘|前程无忧|51job|猎聘)', re.IGNORECASE),
)


def clean_job_description(value: Any) -> str:
    """剥离已知的页面来源噪声与空行塌陷；不重写任何 JD 事实。"""
    text = str(value or '').replace('\u00a0', ' ').strip()
    for pattern in _SOURCE_NOISE:
        text = pattern.sub('', text)
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


# ============================================================
# 招聘类型分类（校招 / 社招 / 未知）
# ============================================================
CAMPUS_MARKERS = ('校招', '校园招聘', '应届', '毕业生', '管培生', '实习生')
EXPERIENCED_MARKERS = ('社招', '社会招聘')
# 「3年以上工作经验」这类明确年限描述视为社招信号
_EXP_YEARS_RE = re.compile(r'\d+\s*(?:[-–~至]\s*\d+\s*)?年(?:以上|及以上)?(?:工作)?经验')
_EXP_FULLMATCH_RE = re.compile(r'\s*\d+\s*(?:[-–~至]\s*\d+\s*)?年(?:以上|及以上)?\s*')


def classify_recruitment_type(title: str = '', experience: str = '', jd: str = '') -> str:
    """保守判定招聘类型：campus / experienced / unknown。

    只在出现明确信号时下结论；拿不准一律 unknown —— 后续 AI 评分再判断，
    本地不做概率性猜测（对齐 BossHunter 的 conservative 口径）。
    """
    text = ' '.join(str(v or '') for v in (title, experience, jd))
    if any(marker in text for marker in CAMPUS_MARKERS):
        return 'campus'
    if any(marker in text for marker in EXPERIENCED_MARKERS):
        return 'experienced'
    if _EXP_YEARS_RE.search(text):
        return 'experienced'
    if _EXP_FULLMATCH_RE.fullmatch(str(experience or '')):
        return 'experienced'
    return 'unknown'


def is_internship_title(title: str) -> bool:
    """标题级实习/管培识别（不含 JD 正文，避免误杀正式岗）。"""
    t = str(title or '').lower()
    return any(s in t for s in ('实习', 'intern', 'internship', '管培'))


# ============================================================
# 统一岗位候选
# ============================================================
@dataclass
class JobCandidate:
    """平台中立的岗位候选（所有采集器的统一出口）。"""

    platform: str
    jobId: str
    title: str
    company: str = ''
    salary: str = ''
    location: str = ''
    experience: str = ''
    degree: str = ''
    labels: list = field(default_factory=list)
    skills: list = field(default_factory=list)
    description: str = ''
    recruiterName: str = ''
    bossTitle: str = ''
    companySize: str = ''
    companyType: str = ''
    url: str = ''
    # 溯源：该岗位由哪个关键词/页面采到（BossHunter 的 source_keyword 口径）
    sourceKeyword: str = ''
    # 采集页序号（1 起；0 = 未知）
    sourcePage: int = 0

    @property
    def storage_id(self) -> str:
        """跨平台唯一存储键：BOSS 沿用裸 jobId（存量兼容），其余 `<platform>:<jobId>`。"""
        if self.platform == 'boss':
            return str(self.jobId)
        return f'{self.platform}:{self.jobId}'

    @property
    def recruitmentType(self) -> str:
        """校招/社招/未知（保守判定，不落库，按需计算）。"""
        return classify_recruitment_type(self.title, self.experience, self.description)

    def to_job_meta(self) -> dict:
        """→ Boss-claw 渲染层 `CamoufoxJob / JobMeta` 兼容结构。

        字段名保持既有口径不变（`JobMeta` 为宽松索引类型，追加字段安全）；
        新增 `sourceKeyword` / `recruitmentType` 仅用于溯源与展示。
        """
        return {
            'platform': self.platform,
            'jobId': str(self.jobId),
            'title': self.title,
            'company': self.company,
            'salary': self.salary,
            'location': self.location,
            'experience': self.experience,
            'degree': self.degree,
            'labels': list(self.labels or []),
            'skills': list(self.skills or []),
            'description': clean_job_description(self.description),
            'recruiterName': self.recruiterName,
            'bossTitle': self.bossTitle,
            'companySize': self.companySize,
            'companyType': self.companyType,
            'url': self.url,
            'sourceKeyword': self.sourceKeyword,
            'recruitmentType': self.recruitmentType,
        }

    def as_dict(self) -> dict:
        """扁平字典（日志 / 能力诊断用）。"""
        payload = asdict(self)
        payload['storageId'] = self.storage_id
        payload['recruitmentType'] = self.recruitmentType
        return payload


def candidates_to_job_meta(candidates: list) -> list:
    """批量转换（兼容 dict 与 JobCandidate 混装，供采集器出口统一收口）。"""
    out: list = []
    for item in candidates or []:
        if isinstance(item, JobCandidate):
            out.append(item.to_job_meta())
        elif isinstance(item, dict):
            out.append(item)
    return out
