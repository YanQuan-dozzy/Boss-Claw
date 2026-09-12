// src/tools/index.mjs —— 工具汇总注册
// 分组：repo（项目认知）/ build（构建验证）/ runtime（运行控制）/ state（状态诊断）/ control（应用控制）
import { repoTools } from './repo.mjs';
import { buildTools } from './build.mjs';
import { runtimeTools } from './runtime.mjs';
import { stateTools } from './state.mjs';
import { controlTools } from './control.mjs';

export const TOOL_GROUPS = [
  { group: 'repo', title: '项目认知', tools: repoTools },
  { group: 'build', title: '构建验证', tools: buildTools },
  { group: 'runtime', title: '运行控制', tools: runtimeTools },
  { group: 'state', title: '状态诊断', tools: stateTools },
  { group: 'control', title: '应用控制', tools: controlTools },
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
