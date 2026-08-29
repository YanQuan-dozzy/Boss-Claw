# BossClaw 使用与开发教程

> 面向求职者的**本地 AI 投递助手**（Electron 桌面应用）——独立运行，不占用你的浏览器；正常上网的同时自动解析简历、匹配岗位并投递简历。

BossClaw 将求职过程中的重复整理工作集中到一个本地桌面应用中：**导入简历 → AI 生成职业画像 → 自主选择投递方向 → 整理岗位信息 → AI 匹配与优先级排序 → 人工确认 / 半自动辅助 → 查看进度与处理异常**，全程数据本地优先、AI 只调用你自己的 Key。

本 Wiki 是 BossClaw 的完整使用与开发教程，按以下页面组织：

| 页面 | 内容 | 适合谁 |
| --- | --- | --- |
| [快速开始](./Quick-Start) | 下载安装、源码构建、首次配置、单条验收 | 所有新用户 |
| [功能指南](./User-Guide) | 全局布局 + 9 大功能模块的详细用法 | 日常使用者 |
| [架构与开发](./Architecture-and-Development) | 技术栈、进程模型、IPC、目录结构、构建打包 | 开发者 / 贡献者 |
| [安全与合规](./Safety-and-Compliance) | 安全边界、安全不变量、数据隐私、免责声明 | 所有用户 / 审核者 |
| [常见问题](./FAQ) | 白屏、登录态、隐身引擎、国内网络等排障 | 遇到问题的人 |

---

## 项目速览

| 项目 | 说明 |
| --- | --- |
| 当前版本 | v2.0.0（桌面版，Windows 10/11 x64） |
| 技术栈 | Electron ^31 · React 18 · TypeScript · Vite 5 · Ant Design 5 · Zustand |
| 许可 | Apache License 2.0 |
| 代码位置 | `desktop-app/`（统一 Electron + React 应用，无需浏览器扩展） |
| 内置浏览器 | Electron `<webview>` 默认加载 BOSS 直聘，登录态本地持久化免重复登录 |
| 数据存储 | 本地优先（localStorage / Zustand persist），零后端依赖 |

## 核心能力一览

- **简历解析**：PDF / DOCX / TXT 本地解析（渲染进程内完成），`.doc` 旧格式给出转档提示
- **AI 职业画像**：AI 生成 + 本地规则三级降级，结果可编辑
- **AI 匹配与排序**：匹配评分、决策、硬条件拦截、沟通草稿；综合匹配度 / HR 活跃度 / 地点 / 薪资 / 新鲜度排序
- **自动沟通**：可选真实浏览器引擎（Camoufox），自动打开沟通窗口、输入并发送打招呼语，发送结果确认后才计成功
- **投递闭环**：工作台三栏（侧栏 + 消息进度 + 内置浏览器），手动 / 半自动投递，任务级进度 + 实时日志 + 失败恢复
- **可选隐身增强**（默认关闭）：Camoufox / CloakBrowser，多内核自适应、不下载额外内核，**不绕过**验证码与账户验证

## 快速链接

- [仓库 README](https://github.com/YanQuan-dozzy/Boss-Claw)（项目主页）
- [下载安装](https://github.com/YanQuan-dozzy/Boss-Claw/releases/latest)（Windows 安装包）
- [权威需求文档](https://github.com/YanQuan-dozzy/Boss-Claw/blob/main/docs/%E6%A1%8C%E9%9D%A2%E7%89%88%E6%94%B9%E9%80%A0%E9%9C%80%E6%B1%82%E6%96%87%E6%A1%A3.md)（`docs/桌面版改造需求文档.md`，v1.2）
- [提交 Issue](https://github.com/YanQuan-dozzy/Boss-Claw/issues)（反馈问题请先阅读[常见问题](./FAQ)）

> 想直接用？进入[快速开始](./Quick-Start)。
