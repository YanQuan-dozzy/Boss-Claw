#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BossClaw 隐身引擎 —— 「基础求职条件」跨平台筛选参数映射层
====================================================================
设置页「求职偏好 → 基础求职条件」（目标城市 / 薪资期望 / 求职类型 / 学历要求 /
经验要求 / 公司规模）是**全平台共用**的一份配置；四个平台的筛选参数名与码值体系
各不相同，本模块把同一份条件翻译成各平台自己的查询参数，供猎聘 / 智联 / 前程无忧
三个隐身采集模块复用（BOSS 由 searchUrl.ts + webview.cjs 处理，不走这里）。

统一入口
--------
    normalize_criteria(raw)                 归一化设置页配置（去空白 / 去「不限」/ 去重）
    build_filter_params(platform, criteria) -> dict[str, str]   平台参数（无值则不含该 key）
    summarize_applied(platform, params)     -> str   日志用「已应用筛选」摘要
    FILTER_CAPABILITIES                     能力表（置信度 + 码值来源，供诊断与文档）

口径来源（2026-09 联网核对 + 实测，逐条标注置信度）
--------------------------------------------------------
【猎聘 liepin】参数名：workYearCode / eduLevel / compScale / jobKind
  · eduLevel（ok，双来源）：010 博士 / 020 MBA·EMBA / 030 硕士 / 040 本科 / 050 大专 /
    060 中专 / 070 中技 / 080 高中 / 090 初中（猎聘学历字典；实测搜索 URL 出现
    eduLevel=040 与「本科」岗位一致）。
  · workYearCode（partial，实测）：区间式**单值**「起始$结束」——0$1 = 1年以内 / 1$3 = 1-3年 /
    3$5 = 3-5年（实测 URL 抓到的三种取值，与所见岗位的「1-3年 / 3-5年」一致）；5$10 按同一
    规律推得。`$` 是**区间分隔**而非多选分隔，因此不支持多选拼接（多选时取第一个可映射项）。
    应届生 / 在校生 / 10年以上 无实测码值 → 不附加（不臆造码）。
  · compScale / jobKind（unsupported）：码值未验证 → 不附加。
【智联 zhaopin】参数名：el / we / cs / jt / sl
  · el（ok，官方字典）：01 初中及以下 / 03 高中 / 04 中专·中技 / 05 大专 / 07 本科 /
    09 硕士 / 11 MBA·EMBA / 15 博士（智联官方字典 dict.zhaopin.cn education.codeForSearch；
    实测 www.zhaopin.com/sou?el=07 被页面计入「清空筛选条件」计数）。
  · we（ok）：0000 无经验 / 0001 1年以下 / 0103 1-3年 / 0305 3-5年 / 0510 5-10年 /
    1099 10年以上。
  · cs（ok）：1 20人以下 / 2 20-99人 / 3 100-499人 / 4 500-999人 / 5 1000-9999人 /
    6 10000人以上。
  · jt（unsupported）：职位类型码值未验证 → 不附加。
【前程无忧 job51】参数名：workYear / degree / companySize / jobType（实测页面筛选面板一致）
  · 码值为 2 位顺位编码（01 起），与平台旧版筛选字段 workyear / degreefrom / jobterm /
    companysize 的口径一致（旧版实测 URL 出现 degreefrom=04、jobterm=01）。新版码值
    无法直连实测（Aliyun WAF 拦脚本请求）→ 整体标记 inferred。
  · 可在真机登录后逐项校准：改下面的 JOB51_* 表即可，无需改动调用方。
"""
from __future__ import annotations

from typing import Any, Iterable

# ============================================================
# 通用归一化
# ============================================================
NO_FILTER_WORDS = ('', '不限', '全部', '不限制', '所有', '不限学历', '经验不限', '全国')

# 多值连接符（各平台多选参数的分隔符不同；猎聘用 `$`，投递类平台用 `,`）
MULTI_SEP = {'liepin': '$', 'zhaopin': ',', 'job51': ','}

# 区间式**单值**维度（P6-12）：值形如「起始$结束」（猎聘 workYearCode 1$3=1-3年），
# $ 是区间分隔而非多选分隔——摘要反查时整体展示，禁止按分隔符拆开（否则 9$12 显示成 9/12）。
_RANGE_SINGLE_DIMS = {('liepin', 'experience')}


def _clean_one(value: Any) -> str:
    v = str(value or '').strip()
    return '' if v in NO_FILTER_WORDS else v


def _clean_list(value: Any) -> list[str]:
    """字符串 / 列表 → 去空、去「不限」、去重且保持原顺序。"""
    if value is None:
        return []
    raw: Iterable[Any]
    if isinstance(value, (list, tuple, set)):
        raw = value
    else:
        raw = str(value).replace('，', ',').replace('、', ',').replace(';', ',').split(',')
    out: list[str] = []
    for item in raw:
        v = _clean_one(item)
        if v and v not in out:
            out.append(v)
    return out


def normalize_criteria(raw: dict | None) -> dict:
    """设置页「基础求职条件」→ 归一化条件字典。

    入参兼容 camelCase（前端 AppConfig）与 snake_case：
      experiences / experience、degrees / degree、companyScale / scale、
      employmentTypes / jobType / job_type、salary
    出参：{salary: str, experience: [str], degree: [str], scale: str, job_type: [str]}
    """
    src = raw if isinstance(raw, dict) else {}

    def pick(*keys: str):
        for k in keys:
            if k in src and src[k] not in (None, ''):
                return src[k]
        return None

    return {
        'salary': _clean_one(pick('salary')),
        'experience': _clean_list(pick('experiences', 'experience')),
        'degree': _clean_list(pick('degrees', 'degree')),
        'scale': _clean_one(pick('companyScale', 'company_scale', 'scale')),
        'job_type': _clean_list(pick('employmentTypes', 'employment_types', 'jobType', 'job_type')),
    }


# ============================================================
# 猎聘 liepin
# ============================================================
# 学历码（猎聘学历字典；040 = 本科 已在实测 URL 中出现）
LIEPIN_EDU = {
    '博士': '010', 'MBA/EMBA': '020', '硕士': '030', '本科': '040', '大专': '050',
    '中专': '060', '中技': '070', '高中': '080', '初中及以下': '090', '初中': '090',
}
# 经验码（区间式；0$1 / 1$3 / 3$5 为实测值，5$10 按同规律推得）
LIEPIN_WORK_YEAR = {
    '1年以内': '0$1', '1-3年': '1$3', '3-5年': '3$5', '5-10年': '5$10',
}


def _liepin_params(c: dict) -> dict:
    out: dict = {}
    # 经验：猎聘 workYearCode 是**区间式单值**（`1$3` 本身即 "1-3年"，`$` 是区间分隔而非多选分隔），
    # 因此多选无法拼接（拼成 `1$3$3$5` 会解析失败）→ 只取用户第一个可映射的经验项。
    for k in c['experience']:
        if k in LIEPIN_WORK_YEAR:
            out['workYearCode'] = LIEPIN_WORK_YEAR[k]
            break
    edu = [LIEPIN_EDU[k] for k in c['degree'] if k in LIEPIN_EDU]
    if edu:
        out['eduLevel'] = MULTI_SEP['liepin'].join(edu)
    # compScale（公司规模）/ jobKind（职位类型）：码值未验证，不附加
    return out


# ============================================================
# 智联招聘 zhaopin
# ============================================================
# 学历码（智联官方字典 education.codeForSearch）
ZHAOPIN_EDU = {
    '初中及以下': '01', '高中': '03', '中专/中技': '04', '中专': '04', '中技': '04',
    '大专': '05', '本科': '07', '硕士': '09', 'MBA/EMBA': '11', '博士': '15',
}
# 经验码（智联参数字典）
ZHAOPIN_EXP = {
    '无经验': '0000', '1年以下': '0001', '1-3年': '0103', '3-5年': '0305',
    '5-10年': '0510', '10年以上': '1099',
}
# 公司规模码（智联参数字典）
ZHAOPIN_SCALE = {
    '0-20人': '1', '20人以下': '1', '20-99人': '2', '100-499人': '3',
    '500-999人': '4', '1000-9999人': '5', '10000人以上': '6',
}


def _zhaopin_params(c: dict) -> dict:
    out: dict = {}
    exp = [ZHAOPIN_EXP[k] for k in c['experience'] if k in ZHAOPIN_EXP]
    if exp:
        out['we'] = MULTI_SEP['zhaopin'].join(exp)
    edu = [ZHAOPIN_EDU[k] for k in c['degree'] if k in ZHAOPIN_EDU]
    if edu:
        out['el'] = MULTI_SEP['zhaopin'].join(edu)
    if c['scale'] in ZHAOPIN_SCALE:
        out['cs'] = ZHAOPIN_SCALE[c['scale']]
    # jt（职位类型）：码值未验证，不附加
    return out


# ============================================================
# 前程无忧 job51（码值 inferred：顺位 2 位编码，待真机登录后校准）
# ============================================================
JOB51_WORK_YEAR = {
    '在校生': '01', '应届生': '01', '1-3年': '02', '3-5年': '03',
    '5-10年': '04', '10年以上': '05',
}
JOB51_DEGREE = {
    '初中及以下': '01', '高中': '02', '中专/中技': '02', '中专': '02', '中技': '02',
    '大专': '03', '本科': '04', '硕士': '05', '博士': '06',
}
JOB51_SCALE = {
    '0-20人': '01', '20人以下': '01', '20-99人': '02', '100-499人': '03',
    '500-999人': '04', '1000-9999人': '05', '10000人以上': '06',
}
JOB51_JOB_TYPE = {'全职': '01', '兼职': '02', '实习': '03'}


def _job51_params(c: dict) -> dict:
    out: dict = {}
    exp = [JOB51_WORK_YEAR[k] for k in c['experience'] if k in JOB51_WORK_YEAR]
    if exp:
        out['workYear'] = MULTI_SEP['job51'].join(dict.fromkeys(exp))
    deg = [JOB51_DEGREE[k] for k in c['degree'] if k in JOB51_DEGREE]
    if deg:
        out['degree'] = MULTI_SEP['job51'].join(dict.fromkeys(deg))
    if c['scale'] in JOB51_SCALE:
        out['companySize'] = JOB51_SCALE[c['scale']]
    jt = [JOB51_JOB_TYPE[k] for k in c['job_type'] if k in JOB51_JOB_TYPE]
    if jt:
        out['jobType'] = MULTI_SEP['job51'].join(dict.fromkeys(jt))
    return out


# ============================================================
# 能力表 / 统一入口
# ============================================================
_BUILDERS = {
    'liepin': _liepin_params,
    'zhaopin': _zhaopin_params,
    'job51': _job51_params,
}

# ok = 码值有权威来源或实测；partial = 部分取值有实测；inferred = 顺位推得待校准；
# unsupported = 码值未知，按「不臆造码、宁可多召回不误杀」原则不附加。
FILTER_CAPABILITIES: dict[str, dict[str, str]] = {
    'liepin': {'experience': 'partial', 'degree': 'ok', 'scale': 'unsupported', 'job_type': 'unsupported'},
    'zhaopin': {'experience': 'ok', 'degree': 'ok', 'scale': 'ok', 'job_type': 'unsupported'},
    'job51': {'experience': 'inferred', 'degree': 'inferred', 'scale': 'inferred', 'job_type': 'inferred'},
}

# 条件维度 → 平台查询参数名（日志 / 诊断用）
PARAM_NAMES: dict[str, dict[str, str]] = {
    'liepin': {'experience': 'workYearCode', 'degree': 'eduLevel', 'scale': 'compScale', 'job_type': 'jobKind'},
    'zhaopin': {'experience': 'we', 'degree': 'el', 'scale': 'cs', 'job_type': 'jt'},
    'job51': {'experience': 'workYear', 'degree': 'degree', 'scale': 'companySize', 'job_type': 'jobType'},
}


# 码值 → 中文标签（日志摘要反查用；避免把「平台侧实际未生效的选项」显示成已应用）
_REVERSE_CODES: dict[tuple[str, str], dict] = {
    ('liepin', 'experience'): {v: k for k, v in LIEPIN_WORK_YEAR.items()},
    ('liepin', 'degree'): {v: k for k, v in LIEPIN_EDU.items()},
    ('zhaopin', 'experience'): {v: k for k, v in ZHAOPIN_EXP.items()},
    ('zhaopin', 'degree'): {v: k for k, v in ZHAOPIN_EDU.items()},
    ('zhaopin', 'scale'): {v: k for k, v in ZHAOPIN_SCALE.items()},
    ('job51', 'experience'): {v: k for k, v in JOB51_WORK_YEAR.items()},
    ('job51', 'degree'): {v: k for k, v in JOB51_DEGREE.items()},
    ('job51', 'scale'): {v: k for k, v in JOB51_SCALE.items()},
    ('job51', 'job_type'): {v: k for k, v in JOB51_JOB_TYPE.items()},
}


def build_filter_params(platform: str, criteria: dict | None) -> dict:
    """把「基础求职条件」翻译成指定平台的查询参数（无对应码值的维度自动省略）。"""
    p = str(platform or '').strip().lower()
    builder = _BUILDERS.get(p)
    if builder is None:
        return {}
    return builder(normalize_criteria(criteria))


def summarize_applied(platform: str, params: dict) -> str:
    """日志摘要：`学历=本科 · 经验=1-3年 · 公司规模=100-499人`（由码值反查中文，单值整体优先）。

    只列出**实际附加到搜索参数里**的维度：平台侧暂无码值的维度不会出现，
    避免用户把「设置里选了但平台未生效」误认为已应用（能力表见 FILTER_CAPABILITIES）。
    """
    p = str(platform or '').strip().lower()
    names = {'experience': '经验', 'degree': '学历', 'scale': '公司规模', 'job_type': '求职类型'}
    sep = MULTI_SEP.get(p, ',')
    parts = []
    for dim, pname in (PARAM_NAMES.get(p) or {}).items():
        v = params.get(pname)
        if not v:
            continue
        rev = _REVERSE_CODES.get((p, dim)) or {}
        if v in rev:  # 区间式/单值（如猎聘 1$3）整体命中
            labels = [rev[v]]
        elif (p, dim) in _RANGE_SINGLE_DIMS:
            labels = [v]  # 区间式单值：不按分隔符拆，原样展示（避免 9$12 被误拆成 9/12）
        else:
            labels = [rev.get(code, code) for code in v.split(sep) if code]
        parts.append(f"{names[dim]}={'/'.join(labels)}")
    return ' · '.join(parts)
