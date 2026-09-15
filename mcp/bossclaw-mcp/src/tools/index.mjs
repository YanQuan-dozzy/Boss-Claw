// src/tools/index.mjs —— 工具汇总注册
// 分组：runtime（运行控制）/ control（应用控制）/ agent（代答）。
// 只面向「控制已安装应用」，不提供任何测试/开发类能力。
import { runtimeTools } from './runtime.mjs';
import { controlTools } from './control.mjs';
import { agentTools } from './agent.mjs';

export const TOOL_GROUPS = [
  { group: 'runtime', title: '运行控制', tools: runtimeTools },
  { group: 'control', title: '应用控制', tools: controlTools },
  { group: 'agent', title: 'agent 代答', tools: agentTools },
];

export const allTools = TOOL_GROUPS.flatMap((g) => g.tools);

/** 校验：工具名唯一且格式合法（MCP 客户端普遍要求 ^[a-zA-Z0-9_-]{1,64}$） */
export function validateTools() {
  const seen = new Set();
  const problems = [];
  for (const t of allTools) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) problems.push(`非法工具名：${t.name}`);
    if (seen.has(t.name)) problems.push(`工具名重复：${t.name}`);
    seen.add(t.name);
    if (typeof t.handler !== 'function') problems.push(`工具缺 handler：${t.name}`);
    if (!t.description || t.description.length < 20) problems.push(`工具描述过短：${t.name}`);
  }
  return { ok: problems.length === 0, problems, count: allTools.length };
}