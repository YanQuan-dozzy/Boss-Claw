# 常见问题（FAQ）

按问题类别整理了使用 BossClaw 过程中最常见的疑问与解决办法。

---

## 一、安装与启动

### Q1：安装 / 启动时提示缺少 Node 或 Electron？

- 源码构建方式需要先安装 [Node.js 20+](https://nodejs.org)（推荐 22）。
- `npm install` 会一并安装 Electron 二进制；若下载失败见 Q3。
- 只想直接使用，请下载 [Releases 里的安装包](https://github.com/YanQuan-dozzy/Boss-Claw/releases/latest)，无需任何开发环境。

### Q2：`npm install` 很慢 / 失败（国内网络）？

```bash
npm install --registry=https://registry.npmmirror.com
```

Electron 二进制下载失败时：

```bash
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ && node node_modules/electron/install.js
```

> 更省事的方式是直接双击仓库根目录的 `install-deps.cmd`，它会自动处理镜像与重试。

### Q3：双击 `start-bossclaw.cmd` 后一闪而过 / 没反应？

- 先确认依赖已装好（`desktop-app/node_modules` 存在），否则先跑 `install-deps.cmd`。
- 用 `start-bossclaw.cmd --visible` 启动，保留控制台查看报错日志。
- 用 `start-bossclaw.cmd --dev` 走 Vite dev server（HMR），便于观察加载情况。

---

## 二、运行与功能

### Q4：启动后白屏？

设置环境变量后重新启动，查看诊断日志：

```bash
set BOSSCLAW_DEBUG=1
start-bossclaw.cmd --visible
```

日志位置：`userData/debug-render.log`（DOM 检查 / 浏览器状态）。

### Q5：首次启动登录态丢失，需要重新扫码？

v3 重建后首次启动会清空旧 `persist:bossclaw` 会话与 Camoufox 缓存（`DATA_VERSION='v3-rebuild-20260815'`）。重新在「设置」或内置浏览器中扫码登录一次即可，之后登录态会本地持久化。

### Q6：AI 相关功能（职业画像 / 岗位匹配 / 沟通草稿）不可用？

- 确认已在「设置」页填写并**测试通过** AI API Key（预设 OpenAI / DeepSeek / 通义千问 / 智谱 GLM / 硅基流动 / 火山方舟，或自定义 OpenAI 兼容端点）。
- 无密钥时相关功能降级为提示，不阻断其他流程（本地规则兜底仍可用）。

### Q7：岗位无法「加入任务」或投递没反应？

- 确认内置浏览器已打开 BOSS 直聘并**登录**（登录态持久化在本地，避免重复登录）。
- 在浏览器中打开目标岗位详情页，再点中栏「加入任务」。
- 页面结构若发生变化（BOSS 改版），任务会暂停并提示，请按[反馈规范](#五反馈与排障)提交 Issue。

### Q8：自动沟通 / 自动辅助没发送成功？

发送结果以**右侧聊天文字气泡确认**为准：未确认自己气泡时，不发送附件、不计成功、不跳下一岗位。请检查：

- 打招呼语非空（AI 生成失败会回退本地规则）
- 沟通对象与岗位一致
- 未出现验证码 / 安全验证（code 35 / 36 / 32 会立即停止交人工）

### Q9：隐身引擎报错「未检测到可用内核」？

- 安装 Chrome / Edge / Firefox 任一浏览器，引擎会自动复用
- 或执行 `pip install 'camoufox[geoip]' && python -m camoufox fetch` 下载指纹内核（约 150MB）

### Q10：CloakBrowser（隐身浏览器）下载慢 / 失败？

首次启用时自动下载约 200MB 隐身 Chromium 到 `~/.cloakbrowser/` 并校验 Ed25519 签名。离线 / 受限环境可手动下载 `.zip` 后设置环境变量 `CLOAKBROWSER_BINARY_PATH` 指向本地二进制。

---

## 三、简历与数据

### Q11：`.doc` 旧格式简历无法解析？

当前支持 PDF / DOCX / TXT 本地解析。`.doc` 旧格式会给出**转档提示**：请用 Word / WPS 另存为 `.docx` 或 `.pdf` 后再导入。

### Q12：数据存在哪里？如何备份 / 迁移？

- 所有数据（简历、画像、筛选条件、API Key、任务记录）保存在**本机 localStorage**（`persist:bossclaw` 系列键）。
- 「设置 → 数据」支持导出 / 导入 / 清空本地数据，可据此备份与迁移。
- 不建议把包含真实简历、API Key 的导出文件提交到公开仓库或 Issue。

---

## 四、安全与合规

### Q13：BossClaw 会不会绕过验证码 / 风控？

不会。这是项目的**硬性边界**：不绕过验证码与账户验证（code 35 / 36 / 32 立即停止交人工）、不自动换号、不突破平台限制。遇到安全验证会立即暂停，由用户人工处理。

### Q14：为什么需要我自己填 API Key？

BossClaw 数据本地优先：AI 只调用**你自己配置的 Key**（OpenAI 兼容端点），不经过第三方平台中转，密钥只存在本机。

---

## 五、反馈与排障

### Q15：遇到问题如何反馈？

先查看本 Wiki 与 [`desktop-app/README.md`](https://github.com/YanQuan-dozzy/Boss-Claw/blob/main/desktop-app/README.md)，再提交 [Issue](https://github.com/YanQuan-dozzy/Boss-Claw/issues)，请包含：

- BossClaw 版本（桌面版 v2.0.0）
- 操作系统与 Electron 版本
- 出错步骤
- **已隐藏隐私信息**的截图（请勿上传含真实简历、手机号、邮箱、身份证信息、API Key 的截图）
- 错误页面中的完整错误信息
