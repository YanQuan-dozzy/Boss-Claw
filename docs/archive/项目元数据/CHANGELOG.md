# Changelog

## 1.4.0 — 窗口桌面版（JobClaw Desktop）

本版本将原本运行于 Chrome 侧边栏的 JobClaw 封装为 **Electron 独立窗口应用**，并吸收了社区 AI-BossJob 的思路进行优化。

### 窗口可视化（桌面应用）

- 新增 `desktop-app/`：Electron 主进程 + 内置浏览器，启动即打开两个窗口——**工作台窗口**（加载 `sidepanel.html`，任务配置/进度/确认主界面）与 **BOSS 窗口**（内置浏览器加载 zhipin.com，自动注入采集脚本）。
- 通过 `src/chrome-main.cjs` 提供的 `chrome.*` 兼容层（storage / tabs / windows / runtime / scripting / debugger / alarms），原扩展 `background.js` 几乎零修改地在主进程复用。
- 工作台针对宽屏做了响应式布局适配（1240×860 起，可缩放）。

### BOSS 的 HR 活跃度检测（不投递最近不活跃的岗位）

- 扩展招聘方活跃状态解析：`在线 / 刚刚活跃 / 今日活跃 / 3日内 / 本周 / 本月 / 2月内 / 3月内 / 半年前 / 1年内 / N年 / N天 / N月`，并区分 `isOnline`（当前在线）与「今日活跃」。
- 新增开关「跳过不活跃 HR」+「HR 活跃天数阈值」（默认 7 天）：招聘方距上次活跃超过阈值时直接跳过该岗位、不投递，并在任务中记录跳过原因。
- 活跃度同时作为**排序软信号**：在线/活跃 HR 岗位优先，长期不活跃即使未过阈值也降权。
- 工作台岗位卡片新增 **HR 活跃度徽章**（在线/活跃度文案配色 + 猎头标识），让检测结果在窗口内可视化。
- 修复 `4月内 / 5月内活跃` 被误判为「半年前活跃」的解析 bug。

### 来自 AI-BossJob 的其它优化

- 多城市自动轮询：搜索时真正应用「工作地点」筛选，投递完一个城市自动切换下一个。
- 猎头过滤增强：扩充猎头识别信号词；归一化剥离完整活跃度短语，提升投递锁与去重准确率。
- 修复「同一 HR 因活跃度文案不同被误判为不同身份」的去重漏洞。

## 1.3.0 — 2026-07-25

### Stability and safety

- Added a first-run single-job validation gate for fully automatic delivery.
- The first successful automatic delivery pauses the queue so the user can verify the actual chat bubble and attachment before continuing in bulk.
- Existing users with successful historical deliveries are migrated as already validated.
- Added a fourth startup readiness item showing the validation state.

### Architecture

- Extracted conversation identity, task-stage metadata, and job-priority logic into focused runtime modules.
- Added unit tests for the extracted modules.
- Split the previous long test command into unit, integration, regression, manifest, syntax, secret-scan, and release-sync checks.

### Open-source and repository quality

- Added Apache License 2.0, NOTICE, attribution guidance, citation metadata, trademark guidance, and a code of conduct.
- Added GitHub Actions for CI, CodeQL, tagged releases, ZIP packaging, and SHA-256 generation.
- Added repository hygiene files and expanded secret scanning.
- Removed generated validation metadata from the repository root.

## 1.2.37 — 2026-07-24

- Added user-selected delivery directions after career-profile generation.
- Search tasks are generated only from explicitly selected and saved directions.
- Preserved AI matching, automatic ranking, manual review, automatic delivery, progress tracking, retry handling, and OpenClaw.
