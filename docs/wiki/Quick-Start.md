# 快速开始

本教程覆盖两种使用方式：

1. **直接使用**：下载安装包，开箱即用（推荐绝大多数用户）
2. **源码构建**：从 GitHub 拉取源码，自行安装依赖并启动（适合开发者 / 想尝鲜新功能的人）

---

## 一、环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / 11（x64） |
| 内存 / 磁盘 | 常规桌面应用水平（约 1~2 GB 可用内存） |
| Node.js | 仅源码构建需要：20+（推荐 22，`.nvmrc` 已固定） |
| Python | 仅「隐身引擎」可选功能需要：3.10+ |

> 官方发行版为 Windows；macOS / Linux 支持源码构建与打包（macOS 安装包需在 macOS 上构建），见[架构与开发](./Architecture-and-Development)。

---

## 二、方式一：下载安装（推荐）

1. 打开 [Releases 页面](https://github.com/YanQuan-dozzy/Boss-Claw/releases/latest)，下载 `BossClaw-2.1.0-x64.exe`（NSIS 安装包）或 `BossClaw-2.1.0-portable.exe`（绿色便携版）。
2. 双击安装，完成后从「开始菜单」启动 BossClaw。
3. 首次启动进入「设置」页，按提示填写**求职条件**与 **AI API Key** 即可使用。

> 安装包约几十 MB；仓库同时保留绿色便携版打包能力（见[架构与开发](./Architecture-and-Development)），解压即用、无需安装。

---

## 三、方式二：从源码构建

> 仓库**不含**任何运行时依赖（`node_modules` / Electron 二进制 / Python 包均需自行下载），首次使用请先准备环境。

### 1. 克隆仓库

```bash
git clone https://github.com/YanQuan-dozzy/Boss-Claw.git
cd Boss-Claw
```

### 2. 安装依赖

**方式 A（推荐，Windows）：一键脚本**

双击仓库根目录的 `install-deps.cmd`，自动完成：

- Node 依赖 + Electron 二进制（国内网络自动重试 npmmirror 镜像）
- 可选：Python 隐身引擎（camoufox + playwright，用于工作台「隐身搜索 / 隐身投递」）

**方式 B（手动）：**

```bash
cd desktop-app
npm install          # 安装依赖（含 Electron 二进制）
```

> **国内网络提示**：
> - `npm install` 失败时加 `--registry=https://registry.npmmirror.com`
> - Electron 二进制下载失败时执行：
>   ```bash
>   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ && node node_modules/electron/install.js
>   ```

### 3. 启动应用

**方式一：一键静默启动（推荐日常使用）**

双击仓库根目录的 `start-bossclaw.cmd`：

- 默认走**快速路径**：直接运行 `dist/` 最后一次构建产物（不启 Vite，启动最快）；若检测到源码有改动会自动先重建再启动。
- `start-bossclaw.cmd --dev`：改用 Vite dev server（HMR，适合改代码时）。
- `start-bossclaw.cmd --visible`：保留控制台窗口并输出日志（调试用），可叠加使用，如 `--dev --visible`。

**方式二：npm 命令（开发者）**

```bash
cd desktop-app
npm run dev          # 启动 Vite dev server（默认 5173）
npm run dev:electron # 构建 renderer 并以 Electron 打开
```

> 开发模式下 Electron 加载 `http://localhost:5173`（自动扫描 5173-5179），失败则回退 `dist/index.html`；生产模式只加载 `dist/index.html`。

---

## 四、首次配置清单

按以下顺序完成一次完整的初始化：

1. **设置求职条件与 AI**（「设置」页）
   - 填写城市、求职类型、经验、学历、薪资条件
   - 填写自己的 AI API Key（预设 OpenAI / DeepSeek / 通义千问 / 智谱 GLM / 硅基流动 / 火山方舟，或自定义 OpenAI 兼容端点）
   - 点击「测试 AI 连接」并保存
2. **导入简历**（「简历中心」页）
   - 上传 PDF / DOCX / TXT，本地解析出可编辑原文并核对
   - `.doc` 旧格式会给出转档提示；解析失败时提供可操作的降级建议
3. **生成并检查职业画像**
   - AI 生成画像后逐项核对个人定位、技能、项目、学历、城市、薪资
   - 删除任何不准确、无证据或夸大的内容，全部字段可编辑并保存
4. **选择投递方向**（「投递方向」页）
   - 勾选准备投递的岗位方向，可修改搜索词、调整优先级、新增自定义方向
   - 系统只为**明确勾选并保存**的方向建立任务
5. **（可选）定制简历**（「定制简历」页）
   - 粘贴目标岗位 JD，AI 生成定制摘要 / 量化经历 / 求职信 / 技能缺口 / 优化建议，仅引用简历真实事实
6. **选择执行模式**（「工作台」页）
   - **人工确认**：AI 完成分析和草稿后，逐条检查、修改、决定是否继续（适合首次使用）
   - **半自动投递**：中栏批准岗位 → 浏览器跳转 → AI 草稿预填沟通框 → **用户点发送**
   - **自动辅助**：按匹配优先级依次投递 `approved_queue` 队列，失败自动暂停交人工核对
   - **自动沟通**：按匹配优先级依次处理队列岗位，真实浏览器打开沟通窗口、输入并发送打招呼语

---

## 五、首次执行：单条验收（重要）

首次使用半自动 / 自动辅助时，**只处理一个由自己确认的岗位**，并逐项确认：

- 当前打开的是用户选择的岗位
- 当前沟通对象与岗位信息一致
- 沟通文字基于真实简历且内容准确
- 页面中确实出现了完整的已发送文字气泡
- 附件只在用户已配置且发送结果可确认时处理
- 任务状态被正确记录
- 没有出现登录异常、安全验证或账号限制

> **任何一步无法确认，都应立即暂停并查看原因，不要连续重复执行。** 首次成功投递一条后，系统会强制暂停待验收。

---

## 六、下一步

- 逐模块了解用法 → [功能指南](./User-Guide)
- 了解架构与参与开发 → [架构与开发](./Architecture-and-Development)
- 遇到问题先查 → [常见问题](./FAQ)
