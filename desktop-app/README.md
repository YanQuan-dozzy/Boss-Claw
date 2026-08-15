# JobClaw 桌面版（Electron + React）

面向求职者的本地 AI 投递助手。单窗口桌面应用：左侧固定功能侧栏 + 对应功能页面；「工作台」为三栏（侧栏 + 消息进度 + 内置浏览器），其余页面为双栏。

## 技术栈

- **Electron** `^31`（主进程 CommonJS：`electron/main.cjs` + `electron/preload/*`）
- **React 18 + TypeScript + Vite**（渲染进程：`src/`）
- **Ant Design 5**（UI）+ **Zustand**（状态，persist 接 localStorage）
- 打包：electron-builder（Windows 优先）

## 目录结构

```
desktop-app/
├── package.json / vite.config.ts / tsconfig*.json / index.html
├── electron/
│   ├── main.cjs                 # 主进程：单窗口 + webview + IPC
│   └── preload/
│       ├── app.cjs              # 主窗口安全接口（contextBridge）
│       └── webview.cjs          # 内置浏览器 guest 页回传
└── src/
    ├── main.tsx / App.tsx / theme.ts / index.css
    ├── store/                   # useAppStore / useDataStore / useSettingsStore
    ├── lib/                     # storage / llm / bridge
    ├── components/              # TitleBar / Sidebar / StatusBar / BrowserView
    └── pages/                   # Home / Workbench / Resume / Directions / Tasks / OpenClaw / Settings
```

## 环境准备（首次运行）

仓库**不包含**任何运行时依赖（node_modules / Electron 二进制 / Python 包均需自行下载），clone 后按以下步骤准备环境：

```bash
# 方式一（推荐，Windows）：一键安装脚本
install-deps.cmd          # 位于仓库根目录，自动完成 1+2，可选 3

# 方式二（手动）：
npm install               # 1. 安装 Node 依赖（含 Electron 二进制）
                          #    国内网络失败时加 --registry=https://registry.npmmirror.com
                          #    或设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
                          #    后执行 node node_modules/electron/install.js
```

> **前置要求**：Node.js 18+（[nodejs.org](https://nodejs.org)）。
> **可选 — 隐身引擎**（工作台「隐身搜索/隐身投递」）：需 Python 3.10+，运行 `install-deps.cmd` 并选择 y，或在 `camoufox/` 目录执行：
> ```bash
> python -m venv .venv
> .venv\Scripts\pip install -r camoufox\requirements.txt
> .venv\Scripts\python -m camoufox fetch   # 可选：下载指纹内核(~150MB)；跳过则自动回退系统 Chrome/Edge
> ```

## 开发运行

```bash
npm install                # 安装依赖
npm run dev                # 启动 Vite dev server（默认 5173）
npm run electron:dev       # 构建 renderer 并以 Electron 打开（生产模式预览）
```

> 开发模式下 Electron 加载 `http://localhost:5173`；生产模式加载 `dist/index.html`。
> 首次运行需在本机有 Electron 运行环境（`npm install` 会安装 `electron` 包及其二进制）。

## 构建与打包

```bash
npm run build              # tsc 类型检查 + vite 构建到 dist/
npm run package            # 构建并打包 Windows 安装包（electron-builder --win）
```

## 功能侧栏入口

首页 · 工作台（三栏自动投递）· 简历中心 · 投递方向 · 任务进度 · OpenClaw · 设置

## 核心闭环

- **岗位来源**：内置浏览器打开 BOSS 直聘岗位 → 点「加入任务」→ 中栏记录（AI 匹配分析 → 待确认）。支持岗位详情页与列表卡片双场景提取，并自动识别 HR 活跃度（在线 / 刚刚活跃 / N 日内活跃）作为匹配判断依据。
- **半自动投递**：中栏批准岗位 → 浏览器跳转 → AI 草稿预填沟通框 → 用户发送。
- **自动辅助**：启动后按匹配优先级依次投递 `approved_queue` 队列；webview 回传投递阶段（打开沟通 → 填写 → 发送 → 确认文字气泡 → 确认结果），失败自动暂停交人工核对；**首次成功投递后强制暂停验收**（安全不变量）。
- **任务进度**：中栏任务级进度条 + 阶段标签（整理 / 匹配 / 排序 / 沟通 / 投递），日志流实时滚动；失败可重试 / 忽略 / 跳过。
- **简历中心**：PDF / DOCX / TXT 本地解析（渲染进程内完成，无需桥接）：PDF 用自研解析器（Flate / ASCIIHex / ASCII85 / RunLength + ToUnicode / CMap），DOCX 用 mammoth 浏览器版 + 自研 ZIP/XML 双通道兜底，`.doc` 旧格式给出转档提示；解析失败时提供可操作降级建议。
- **AI 能力**：职业画像（AI 完整画像 → 精简重试 → 本地规则三级降级）；岗位匹配（评分 / 决策 / 硬条件拦截 / 沟通草稿）；**4 条个性化打招呼语**（AI 生成 + 求职者口吻校验，失败回退本地规则）。未配置密钥时相关功能降级不阻断流程。
- **LLM 预设**：OpenAI / DeepSeek / 通义千问 / 智谱 GLM / 硅基流动 / 火山方舟 / 自定义（OpenAI 兼容端点）。
- **OpenClaw 桥接**：本地 Node 服务（127.0.0.1:18765）提供状态 / 日报 / 指令控制 / OCR / 简历解析 / **日志查看**；主进程自动拉起。
- **主题**：浅色 / 深色 / 跟随系统（antd + CSS 变量，状态持久化）。
- **数据**：设置页可导出 / 导入 / 清空本地数据（localStorage）。
- **安全**：不实现也不提供绕过平台安全措施的能力（验证码 / 频率限制 / 指纹伪装等）；设置页含「投递安全」提示（频率控制、HR 活跃度、图片简历脱敏）。

## 需求文档

完整需求见仓库根：`docs/桌面版改造需求文档.md`（v1.2）。
