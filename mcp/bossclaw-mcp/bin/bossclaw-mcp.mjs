#!/usr/bin/env node
// bin/bossclaw-mcp.mjs —— BossClaw MCP 服务入口（stdio）
// 用法：node bin/bossclaw-mcp.mjs
// 环境变量：
//   BOSSCLAW_REPO      覆盖仓库根路径（默认由本文件位置推导）
//   BOSSCLAW_USERDATA  覆盖 Electron userData 目录（默认 %APPDATA%/BossClaw）
//   BOSSCLAW_MCP_DEBUG 置 1 时把 stderr 日志也写一份到 mcp/bossclaw-mcp/mcp-debug.log
import { createServer } from '../src/server.mjs';
import { allTools, validateTools } from '../src/tools/index.mjs';
import { REPO_ROOT, DESKTOP_DIR, PATHS, readControlBridgeInfo } from '../src/context.mjs';

const { ok, problems, count } = validateTools();
if (!ok) {
  process.stderr.write(`[bossclaw-mcp] 工具注册校验失败：\n${problems.join('\n')}\n`);
  process.exit(1);
}

const instructions = [
  'BossClaw 应用操作 MCP —— 让 agent 能够读取、启动、诊断并驱动已安装的 BossClaw 桌面应用（如 F:\\BOSSClaw）。',
  '',
  `工作区根：${REPO_ROOT}`,
  `应用目录：${DESKTOP_DIR}`,
  `应用数据目录：${PATHS.userData}`,
  `本地备份快照：${PATHS.backupFile}`,
  '',
  '推荐工作流：',
  '  1) bossclaw_guidelines（读约束与安全不变量）→ bossclaw_project_info（建立应用总览）',
  '  2) 理解应用：bossclaw_list_dir / bossclaw_read_file / bossclaw_search',
  '  3) 观察/驱动运行中的应用：bossclaw_app_start（默认开控制桥）→ bossclaw_app_state → bossclaw_app_action',
  '  4) 排查现场：bossclaw_logs（app/render/webview）+ bossclaw_state_summary（任务与安全状态）',
  '',
  '单向链路：仅 agent → MCP → 应用（启动/状态/动作）。应用内按钮不再转交 agent 代答；',
  '未配置 API Key 时 AI 功能走应用内本地规则兜底。',
  '',
  '工作区边界：仅读取已安装打包版（如 F:\\BOSSClaw，含 resources/app）内的文件；',
  '开发/源码类内容不提供（git、构建、冒烟测试等一律不开放）。',
  '',
  '硬性约束（不可违反，详见 bossclaw_guidelines）：',
  '  · 不绕过验证码 / 速率限制；不自动批量投递；不代替用户确认文字气泡；',
  '  · 首次成功投递后必须暂停验收；验证码与风控码（31/32/35/36/37/38）一律停止交人工；',
  '  · 渠道以 job-claw-main 的既有实现为准，禁止重新发明业务逻辑。',
].join('\n');

const server = createServer({ tools: allTools, instructions });

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('uncaughtException', (e) => {
  process.stderr.write(`[bossclaw-mcp] 未捕获异常：${e?.stack || e}\n`);
});

// 启动时探测一次控制桥，便于日志定位
readControlBridgeInfo()
  .then((info) => {
    if (info) process.stderr.write(`[bossclaw-mcp] 控制桥记录：port=${info.port} pid=${info.pid} stale=${!!info.stale}\n`);
  })
  .catch(() => {});

process.stderr.write(`[bossclaw-mcp] 已注册 ${count} 个工具\n`);
server.start();
