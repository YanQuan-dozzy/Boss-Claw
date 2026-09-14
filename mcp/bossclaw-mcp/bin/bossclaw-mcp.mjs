#!/usr/bin/env node
// bin/bossclaw-mcp.mjs —— BossClaw MCP 服务入口（stdio）
// 用法：node bin/bossclaw-mcp.mjs
// 环境变量：
//   BOSSCLAW_REPO      覆盖仓库根路径（默认由本文件位置推导）
//   BOSSCLAW_USERDATA  覆盖 Electron userData 目录（默认 %APPDATA%/BossClaw）
//   BOSSCLAW_MCP_DEBUG 置 1 时把 stderr 日志也写一份到 mcp/bossclaw-mcp/mcp-debug.log
import { createServer } from '../src/server.mjs';
import { allTools, validateTools } from '../src/tools/index.mjs';
import { DESKTOP_DIR, PATHS, readControlBridgeInfo } from '../src/context.mjs';

const { ok, problems, count } = validateTools();
if (!ok) {
  process.stderr.write(`[bossclaw-mcp] 工具注册校验失败：\n${problems.join('\n')}\n`);
  process.exit(1);
}

const instructions = [
  'BossClaw 应用操作 MCP —— 让 agent 只能**控制已安装的 BossClaw 桌面应用**（如 <安装目录>）：启动/停止/运行状态 + 实时内存状态 + 白名单动作。不提供任何测试/开发类能力。',
  '',
  `应用目录：${DESKTOP_DIR}`,
  `应用数据目录：${PATHS.userData}`,
  '',
  '推荐工作流：',
  '  1) bossclaw_app_status（应用是否在跑 / 控制桥是否就绪）',
  '  2) bossclaw_app_start（启动；默认开启应用内控制桥）',
  '  3) bossclaw_app_state（实时状态：路由 / 队列 / 统计 / 投递安全参数 / 日志尾部）',
  '  4) bossclaw_app_action（白名单动作：切页 / 暂停续投 / 配置 / 数据 / AI 生成 / 截图等）',
  '',
  '单向链路：仅 agent → MCP → 应用（启动/状态/动作）。应用内 AI 能力在未配置 API Key 时走本地规则兜底。',
  '',
  '硬性约束（不可违反）：',
  '  · 不绕过验证码 / 速率限制；不自动批量投递；不代替用户确认文字气泡；',
  '  · 首次成功投递后必须暂停验收；验证码与风控码（31/32/35/36/37/38）一律停止交人工；',
  '  · 自动发送（deliverySendNow）仅当用户在应用内开启「全自动」（executionMode=auto）时可用；review 模式只能草拟+人工发送；',
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
