// src/knowledge.mjs —— 操作型 agent 的「随身手册」
// ---------------------------------------------------------------------------
// 内容来源：AGENTS.md（项目约束唯一入口）、docs/ 下需求与使用文档、
// 以及 .workbuddy/memory/MEMORY.md 里沉淀的工程结论。
// 维护约定：AGENTS.md 或关键约定变更时同步更新本文件。
export const CONVENTIONS = {
  commands: {
    start: '启动推广版本：<安装目录>\\BossClaw.exe（或 start-bossclaw.cmd）',
    startBridge: '本地启动器 start-bossclaw.cmd 默认开启控制桥（--no-agent 关闭）',
    env: 'BOSSCLAW_CONTROL=1 环境变量或 --control-bridge 开关开启控制桥',
  },
  sandboxTraps: [
    '沙箱会注入 NODE_OPTIONS / ELECTRON_RUN_AS_NODE / PYTHONPATH，必须清掉后再启动 Electron 与 tsc/vite（本 MCP 已自动清理）。',
    'tsc -b 有增量缓存（tsbuildinfo）：若怀疑缓存导致误判，先 touch 任一 src 文件再跑。',
    '禁用 npx 与 .bin（曾被清理），一律 node node_modules/<pkg>/bin.js。',
    '沙箱禁止 cmd.exe；.cmd 脚本（start-bossclaw.cmd 等）的端到端验证必须在真机跑。',
    '中文 Win11 下 .cmd 必须 GBK(936) + CRLF；必须用 Python gbk codec 读写，PowerShell 的 [IO.File] 会静默转成 GBK。',
  ],
  invariants: [
    '首次成功投递一条后必须暂停验收，让用户核对聊天对象、文字气泡与附件。',
    '聊天文字气泡未确认时：不发送附件、不计成功、不跳下一个岗位。',
    '目标 HR 或会话明确冲突时：不发送。外部网申岗位直接跳过（优先级 -6000）。',
    '验证码 / 风控 / 账户异常（code 31/32/35/36/37/38）→ 立即停止交人工，绝不自动重试或换号。',
    '禁止绕过 CAPTCHA、绕过速率限制、自动批量投递、多城市轮询。',
    '不得替用户承诺薪资、到岗时间、面试时间或不存在的经历；招呼语必须用求职者口吻且只引用真实简历事实。',
    '每日投递默认 120/日，硬上限 SAFETY_LIMITS.MAX_SAFE_DAILY=150（safety.ts）。',
  ],
  layoutInvariant:
    '内置浏览器 <webview> 依赖宿主 display:flex; flex:1; width/height:100% —— 绝不可改 display；尺寸变化统一走 BrowserView.tsx 的 ResizeObserver/sidebarCollapsed → force-resize IPC。',
  persistence: {
    'bossclaw-app': 'useAppStore（theme / activeRoute / autoAssist / engineStatus / sidebarCollapsed）',
    'bossclaw-settings-v2': 'useSettingsStore（config：投递参数、安全冷却 pausedUntil、platforms）',
    'bossclaw-data': 'useDataStore（简历 / 画像 / greetings / pending / taskRuns / stats / logs / chatLogs）',
    'bossclaw-schedule': 'useScheduleStore（定时任务 entries）',
    note: 'Zustand persist → localStorage；本地备份快照由 5 分钟脏检查写入备份目录的 bossclaw-local-backup.json。',
  },
  theme: [
    'Teal-on-Neutral：页面底色/边框/悬停用中性 slate；品牌青绿 #0D9488 只用于激活/选中/主操作。',
    '变量双源同值：antd ConfigProvider token（src/theme.ts）与 index.css :root / html[data-theme=dark] 必须同步修改。',
    '深色模式必须保证文字为浅色；数字统一 var(--font-mono)；body 开启 tabular-nums。',
  ],
  platformColors: '多平台 chip 品牌色 PLATFORM_CHIP_PALETTE：BOSS 绿 / 猎聘 蓝 / 智联 橙 / 51Job 紫。',
  keyFiles: {
    'electron/main.cjs': '主进程（窗口、webview、IPC、camoufox/cloak 引擎、备份、PDF）',
    'electron/preload/app.cjs': '主窗口 contextBridge API（渲染层 electronApi）',
    'electron/preload/webview.cjs': 'webview preload（CommonJS！HMR 不覆盖，改动必须重启 Electron）；风险检测/采集/输入合成',
    'src/pages/Workbench.tsx': '工作台三栏（侧栏 + 中栏进度 + 右栏内置浏览器）',
    'src/lib/bossclaw/matching.ts': 'AI 打招呼 / 沟通匹配',
    'src/lib/bossclaw/safety.ts': 'SAFETY_LIMITS 与错误码 → 风险信号映射',
    'src/lib/taskState.ts': '阶段机与 PHASE_LABELS（搜索→匹配→确认→投递→完成）',
    'src/lib/persistSafe.ts': '安全持久化（防抖 + 写哨兵）',
    'src/lib/localBackup.ts': '本地备份快照读写与恢复',
    'camoufox/camoufox_server.py': 'Camoufox 隐身引擎桥（端口 18767，token bossclaw-camoufox）',
  },
};

export const REQUIRED_READING = [
  { path: 'AGENTS.md', why: '项目约束唯一入口：最高优先级工作流、必须对齐的逻辑模块、安全不变量、红线' },
  { path: 'docs/桌面版改造需求文档.md', why: '当前产品需求基线（实现前必读）' },
  { path: 'docs/使用注意事项.md', why: '交互与使用约束' },
  { path: 'docs/wiki/Architecture-and-Development.md', why: '技术栈 / 进程模型 / IPC 总线 / 目录结构' },
  { path: 'desktop-app/README.md', why: '应用侧构建、启动、打包说明' },
];

export const REFERENCE_PROJECTS = [
  { path: 'job-claw-main', why: '业务逻辑对齐源（task-state / job-priority / conversation-identity / content-v37.js 采集）——禁止重新发明' },
];

export const OPERATING_LOOP = [
  '1) 先 bossclaw_guidelines 读约束与安全不变量。定位边界：agent 只能控制/读取已安装应用，不涉及测试与开发。',
  '2) 定位/理解应用：bossclaw_workspace（工作区根）+ bossclaw_app_status（运行态）；按需用 bossclaw_list_dir / bossclaw_read_file / bossclaw_search（仅安装包或显式指定的工作区根内）。',
  '3) 要观察或驱动运行中的应用：bossclaw_app_start（默认开控制桥）→ bossclaw_app_state（实时状态）→ bossclaw_app_action（白名单动作）。',
  '4) 排查现场：bossclaw_logs（app/render/webview）+ bossclaw_state_summary（任务与安全状态）。',
];
