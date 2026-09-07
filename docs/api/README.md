# BossClaw 桌面版 · API 接口文档

本目录是 BossClaw 桌面应用（Electron + React）**对外接口的完整文档**，与代码
（`desktop-app/electron/*`、`desktop-app/bridge/*`、`desktop-app/camoufox/*`）同步维护。

> 阅读入口：`api-doc.html`（离线单页可视化）；机器可读规范见两份 OpenAPI YAML；
> IPC 与页面注入接口见 `ipc-api.md`。

---

## 1. 进程拓扑与接口分布

BossClaw 不是传统 Web 后端——它运行在你本机，接口分为 **本地 HTTP 服务** 与
**Electron IPC / 页面注入桥** 两类：

```
┌────────────────────────────────────────────────────────────────┐
│ Electron 主进程 (electron/main.cjs)                             │
│   ├─ 拉起 Bridge 子进程（ELECTRON_RUN_AS_NODE=1）               │
│   │     └─ bridge/server.cjs  →  http://127.0.0.1:18765        │
│   ├─ 拉起 Python 子进程（隐身引擎）                              │
│   │     └─ camoufox_server.py  →  http://127.0.0.1:18767        │
│   ├─ CloakBrowser launcher（可选，Playwright 持久上下文）         │
│   └─ IPC 层：jc:* 通道（window.electron  ↔ 主进程）              │
├────────────────────────────────────────────────────────────────┤
│ 渲染进程（React，src/）                                          │
│   ├─ 经 window.electron.* 调主进程（IPC，见 ipc-api.md §2）       │
│   ├─ 直接 fetch 本地 HTTP（bridge / camoufox），携带 ?token=…   │
│   └─ 经 <webview>.send()/事件 控制 BOSS 页面桥（见 ipc-api.md §4）│
└────────────────────────────────────────────────────────────────┘
```

| 接口面 | 端口 / 载体 | 鉴权 | 文档 |
|---|---|---|---|
| OpenClaw 本地桥接服务 | `127.0.0.1:18765` | `?token=bossclaw-desktop-bridge` | `openapi-bridge.yaml` |
| Camoufox 隐身引擎桥 | `127.0.0.1:18767` | `?token=bossclaw-camoufox` | `openapi-camoufox.yaml` |
| 主窗口 IPC（40+ `jc:*` 通道） | Electron IPC | 无（渲染层信任边界 + contextIsolation） | `ipc-api.md` §2–3 |
| BOSS 页面桥（webview） | `<webview>` host⇄guest | 注入标记 `__bossclawPreload` | `ipc-api.md` §4 |
| CloakBrowser 页面桥 | launcher ⇄ Page | 注入标记 `__bossclaw_installed__` | `ipc-api.md` §5 |

## 2. 本地 HTTP 服务

两个服务都只监听 `127.0.0.1`，用**静态令牌**鉴权（query 参数 `token`），失败返回
`HTTP 403 { ok:false, error:"token denied" }`。它们由主进程随应用按需拉起
（Bridge 走 `jc:bridge-control`，Camoufox 走状态检测自愈），也可手动启动：

```bash
# Bridge
node desktop-app/bridge/server.cjs          # 或主进程 spawn（ELECTRON_RUN_AS_NODE=1）
# Camoufox 隐身引擎桥（依赖 .venv：camoufox + playwright）
desktop-app/.venv/Scripts/python.exe desktop-app/camoufox/camoufox_server.py --port 18767 --token bossclaw-camoufox
```

**重要：HTTP 状态 ≠ 业务成败。** 两个桥的业务失败（如未登录 `code 31`、需人工验证
`code 35`）都以 `HTTP 200 + { ok:false, code, message }` 返回；HTTP 4xx/5xx 仅表示
鉴权失败、参数缺失、路径不存在或内部异常。`code` 语义见
`openapi-camoufox.yaml` 的 `components.schemas.Code.x-code-table`。

## 3. 安全模型与红线

- 两个 HTTP 服务的令牌为**代码内静态常量**，仅因「只监听回环 + 桌面本机」而可用；
  请勿将其暴露给局域网或修改为监听 `0.0.0.0`。
- 与求职平台交互存在**安全不变量**（对应 AGENTS.md §2.1 / §4.2）：
  - `code 36 / 32 / 35`（风控 / 需人工验证）→ **立即停止并转人工**，绝不自动重试、
    绝不绕过验证码或账户验证；
  - 自动沟通/招呼语发送有每日配额与限速（渲染层 safety.ts 控制）；
  - 不进行批量自动化投递或跨平台轮询。
- 修改接口时保持 `ipc-api.md §6` 的一致性要求。

## 4. 文件导览

| 文件 | 内容 | 建议打开方式 |
|---|---|---|
| `api-doc.html` | 离线单页可视化文档（两 HTTP 服务 + IPC 摘要 + 安全模型） | 双击浏览器打开 |
| `openapi-bridge.yaml` | Bridge（18765）OpenAPI 3.0.3 规范，含请求/响应 schema 与示例 | Swagger Editor / VS Code OpenAPI 插件 / `npx @redocly/cli preview-docs` |
| `openapi-camoufox.yaml` | Camoufox 引擎桥（18767）OpenAPI 3.0.3 规范 | 同上 |
| `ipc-api.md` | `window.electron.*` 方法目录、事件推送、webview / CloakBrowser 页面桥 | Markdown 阅读器 |
| `README.md`（本文件） | 总览与导航 | — |

> `api-doc.html` 为便于阅读的**快照**；机器可读与**最新事实以 OpenAPI YAML 与
> `ipc-api.md` 为准**。改动代码后请同步更新本目录文档。

## 5. 快速自测

```bash
# 语法校验（js-yaml）
node -e "const fs=require('fs'),y=require('js-yaml'); \
  for (const f of ['docs/api/openapi-bridge.yaml','docs/api/openapi-camoufox.yaml']) \
    y.load(fs.readFileSync(f,'utf8')) && console.log(f,'OK')"

# 应用运行时手动探测（需桥已启动）
curl "http://127.0.0.1:18765/status?token=bossclaw-desktop-bridge"
curl "http://127.0.0.1:18767/status?token=bossclaw-camoufox"
```
