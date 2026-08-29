---
name: bossclaw-resume-profile
description: 简历 → 职业画像：本地规则锚点 + AI 精修，方向覆盖全行业职能岗位。触发词：生成画像、职业画像、分析简历、生成职业画像。
---

# 职业画像（resume-profile）

> 本项目技能（Agent Skills 格式，对齐 `F:\projects\job-claw-main\skills\jobclaw\SKILL.md` 与
> GitHub ai-job-search / job-seeker 的可插拔 skills 体系）。软件运行时的权威定义在
> `desktop-app/src/lib/bossclaw/skills.ts`（scope `profile`），本文件为与之同步的完整技能定义。

## 触发

用户生成/刷新职业画像（简历中心「生成职业画像」）时，软件自动启用本技能；agent 侧触发词：生成画像、职业画像、分析简历。

## 软件集成

- 调用点：`desktop-app/src/lib/bossclaw/profile.ts` `buildProfile`（完整 + 精简重试两处）
- 作用域：`profile`（AI 缓存 scope，`llm.ts`）
- 注入方式：启用时把下方「指令」追加到画像 system prompt 末尾（`skillInstructionsFor('profile')`）
- 启停：设置 → AI/LLM → AI 技能（默认启用）

## 指令（注入 system prompt 的增强约束）

仅使用简历真实事实生成画像，禁止推断或编造技能/经历/成果；主方向覆盖全部职业场景（技术/产品/设计/运营/市场/销售/人力资源/财务/法务/行政/客服/供应链/制造/建筑/医疗/教育/传媒/咨询/电商/翻译等全行业职能岗位），按整体技能栈权重判断，不得仅因前端关键词把全栈/后端/AI 背景误判为前端；在校生/应届生岗位名一律用「XX实习生」且求职类型以「实习」为先，社会求职者用正式岗位名且求职类型为「全职」；搜索词必须是真实岗位名称；教育/经历/项目各最多 4 条、每条不超过 80 字，技能最多 15 个，摘要 120-180 字且只引用简历事实；即使信息不完整也必须给出可编辑初稿，禁止返回空内容。

## 流程（软件内）

1. 本地规则生成锚点初稿：`buildLocalProfile`（`helpers.ts` 的 `inferDirections` / `buildSearchKeywords` / `extractDegree` 等，按技能栈权重与岗位方向目录）。
2. AI 精修：`cachedCallModel`（scope `profile`，key 含简历全文与锚点，简历未变重复生成直接命中缓存）→ `validateGeneratedProfile` 校验字段完整。
3. 合并兜底：`mergeProfileWithFallback` —— AI 输出异常/不完整自动回退本地规则，绝不把 AI 跑偏结果当最终画像。
4. 输出归一化：`normalizeProfile` / `profileToDraft` / `profileFromDraft`（可编辑草稿双向转换）。

## 安全不变量

- 只引用简历真实事实；不得编造技能、经历、成果、薪资承诺。
- 即使信息不完整也必须给出可编辑初稿，禁止返回空内容（本地规则兜底）。

## 方法论来源

- ai-job-search（Factual Grounding 事实核查：来源中不存在的事实 = 不存在，不得补写）
- job-claw-main 画像口径（`source/src/lib/` 的 profile 逻辑）
