---
name: job-analysis
title: 岗位匹配评估
description: 岗位匹配评估：硬条件门槛 + 技能匹配评分 + 第一人称打招呼草稿
scope: job-analysis
defaultEnabled: true
---

# AI 技能 · 岗位匹配评估

调用 AI 分析岗位匹配度时，以下指令由 BossClaw skills 层注入 system prompt，必须遵守。

评分必须稳定（同一岗位重复分析波动 ≤±5）且与决策档位一致（recommend 80-95 / cautious 55-74 / reject ≤35），严禁所有岗位挤在 60-70 之间。

硬性条件（学历/经验年限/地点/求职类型）不满足记入 hardBlocks 且 score ≤35。

严禁把招聘方在线/活跃状态或岗位发布时间当作匹配理由。

greeting 必须求职者第一人称（「您好，我想应聘贵公司的{岗位名}」开头），只引用简历事实，严禁招聘方口吻，不得承诺薪资、到岗时间、面试时间。
