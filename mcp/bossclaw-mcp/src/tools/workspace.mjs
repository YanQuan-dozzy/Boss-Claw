// src/tools/workspace.mjs —— 工作区路径选择工具组
// ---------------------------------------------------------------------------
// 解决「工作区根在不同启动上下文解析不一致、旧安装副本残缺导致各类工具返回空值」的问题。
// 提供三类能力：
//   - list   ：自寻路径 + 询问。列出所有候选工作区与健康度，标注当前生效根是否完整，
//              供 agent 决定「自选」或「询问用户后 prefer」。
//   - prefer ：持久化指定一个工作区根（写入 .workspace-root），使后续调用一致。
//   - clear  ：清除持久化指定，回到自寻路径。
// 说明：REPO_ROOT / PATHS 是 import 期常量，prefer 写下的覆盖在「下次启动 MCP 进程」生效；
//       想立即生效请设 BOSSCLAW_REPO 环境变量。
import {
  REPO_ROOT,
  DESKTOP_DIR,
  MODE,
  WORKSPACE_FILE,
  WORKSPACE_OVERRIDE_ACTIVE,
  workspaceHealth,
  listWorkspaceCandidates,
  setWorkspaceOverride,
  clearWorkspaceOverride,
  ok,
  fail,
} from '../context.mjs';
import { obj, str, enumStr, READ_ONLY, WRITE_LOCAL } from '../schema.mjs';

function candidateLines(candidates, highlightRoot) {
  const lines = [];
  for (const c of candidates) {
    const current = c.root === highlightRoot ? '  ← 当前生效' : '';
    const status = c.complete ? '✅ 完整' : c.type === 'installed' ? '⚠️ 不完整（旧副本）' : '−';
    lines.push(
      `  - [${c.type}] ${c.root}  ${status}${current}\n` +
        `      exe=${c.hasExe ? '✓' : '−'} packageJson=${c.packageJson ? '✓' : '✗'} desktopApp=${c.hasDesktopApp ? '✓' : '−'} —— ${c.reason}`
    );
  }
  return lines.join('\n');
}

export const workspaceTools = [
  {
    name: 'bossclaw_workspace',
    title: '工作区路径选择 / 诊断 / 修改',
    description:
      '展示并管理 MCP 所针对的「工作区根」：列出安装版(如 <安装目录>)与开发仓库候选、各自完整度（是否缺 resources/app/package.json），' +
      '并高亮当前生效根与其健康度，便于发现「旧安装副本残缺导致读取返回空值」的根因。' +
      'action=list 用于诊断（只读）；action=prefer 可持久化指定一个工作区根，使后续多次调用一致；' +
      'action=clear 清除持久化指定回到自寻路径。注意 prefer 写入的覆盖在下次启动 MCP 进程生效。',
    annotations: READ_ONLY, // list 只读；prefer/clear 会写本地小文件，但不同时标注写注解（行为由返回说明）
    inputSchema: obj(
      {
        action: enumStr('要执行的动作', ['list', 'prefer', 'clear']),
        path: str('action=prefer 时的绝对路径（要指定为工作区根的目录）'),
      },
      []
    ),
    handler: async (args = {}) => {
      const action = args.action || 'list';
      const candidates = listWorkspaceCandidates();
      const currentComplete = workspaceHealth(REPO_ROOT).complete;

      if (action === 'clear') {
        const removed = clearWorkspaceOverride();
        return ok(
          [
            `# 工作区覆盖已${removed ? '清除' : '无需清除（本无覆盖文件）'}（${WORKSPACE_FILE}）`,
            '',
            `- 当前生效根：${REPO_ROOT}（MODE=${MODE}）`,
            '- 已经回退到自寻路径（优先完整 bundle）。',
            '- 想在本进程立即生效，请重启 MCP 或设置 BOSSCLAW_REPO 环境变量。',
          ].join('\n'),
          { action, cleared: removed, effectiveNow: REPO_ROOT, overrideFile: WORKSPACE_FILE }
        );
      }

      if (action === 'prefer') {
        const p = String(args.path || '').trim();
        if (!p) {
          return fail('action=prefer 必须提供 path（绝对目录路径）。', { action, candidates });
        }
        const health = workspaceHealth(p);
        if (!health.bossclawRoot && !health.hasExe) {
          return fail(
            ['无法把该路径识别为 BossClaw 工作区（应含 BossClaw.exe、desktop-app/ 或 AGENTS.md）：', `  ${p}`, '', '当前候选：', candidateLines(candidates, REPO_ROOT)].join('\n'),
            { action, requested: p, candidates }
          );
        }
        const written = setWorkspaceOverride(p);
        return ok(
          [
            `# 工作区根已${written ? '持久化指定' : '写入失败'}`,
            `- 目标（下次启动生效）：${p}（完整度 ${health.complete ? '✅ 完整' : '⚠️ 不完整'}）`,
            `- 当前进程仍用：${REPO_ROOT}（MODE=${MODE}）`,
            `- 覆盖文件：${WORKSPACE_FILE}`,
            '- 要立即生效：设置 BOSSCLAW_REPO 指向该路径后重启 MCP 实例。',
            written ? '后续新 MCP 进程将统一解析到该工作区，避免各次路径不一致。' : '请检查文件系统权限后重试。',
          ].join('\n'),
          {
            action,
            applied: written,
            requested: p,
            requestedComplete: health.complete,
            effectiveNow: REPO_ROOT,
            effectiveNextStart: p,
            overrideFile: WORKSPACE_FILE,
            overrideActive: WORKSPACE_OVERRIDE_ACTIVE,
            candidates,
          }
        );
      }

      // 默认 list（只读诊断）
      const lines = [
        '# 工作区路径诊断',
        '',
        `- 当前生效根：${REPO_ROOT}（MODE=${MODE}）`,
        `- 应用目录：${DESKTOP_DIR}`,
        `- 持久化覆盖：${WORKSPACE_OVERRIDE_ACTIVE ? '存在' : '无'}（${WORKSPACE_FILE}）`,
        `- 当前根完整度：${currentComplete ? '✅ 完整可用' : '⚠️ 不完整（读应用清单会返回空值）'}`,
        '',
        '候选工作区：',
        candidateLines(candidates, REPO_ROOT),
        '',
        currentComplete
          ? '当前工作区完整可用，可直接使用。如需切换到其它候选，可 action=prefer 指定。'
          : [
              '⚠️ 当前根不完整（多为旧安装副本缺 resources/app/package.json）。',
              '建议：让用户选择一个完整候选，或提供自定义路径，用 action=prefer 持久化；',
              '也可直接设 BOSSCLAW_REPO 环境变量（立即生效）。',
            ].join('\n'),
      ];
      return ok(lines.join('\n'), {
        action,
        effectiveRoot: REPO_ROOT,
        mode: MODE,
        desktop: DESKTOP_DIR,
        overrideFile: WORKSPACE_FILE,
        overrideActive: WORKSPACE_OVERRIDE_ACTIVE,
        currentComplete,
        candidates,
      });
    },
  },
];