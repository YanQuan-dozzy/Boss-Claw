// progress-stage-regression.mjs —— 求职流程进展（P1-6）回归断言
//
// 为什么需要它：progressStage 是**与投递状态正交**的流程字段，只在统计与岗位卡展示，
// 不参与投递判定。它的风险都藏在「静默」里：
//   · 旧数据没有该字段 / 脏值 → 统计必须归「未标记」，不能报错、不能被算成某个具体阶段；
//   · AI 跟聊每次识别到约面都会回调 → 已面试 / 已获 Offer / HR 已拒绝不得被改回「已约面」；
//   · HR 拒绝是终态 → 必须覆盖更早的阶段；
//   · 漏斗「面试」必须来自真实字段，不能仍是写死的 0。
//
// 前半段跑真实 progressStage.ts / statsAggregate.ts 的运行时行为，后半段对源码做结构守卫
// （自动写入点、统计页展示、两个岗位卡入口），防止后续重构把接线删掉而不报错。
//
// 用法：node scripts/progress-stage-regression.mjs   （EXIT 0 = 全通过，1 = 有失败）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; return; }
  fails.push(name + (detail ? '  → ' + detail : ''));
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}

const dir = mkdtempSync(join(tmpdir(), 'bossclaw-progress-'));
const outfile = join(dir, 'bundle.cjs');
try {
  await build({
    stdin: {
      contents: [
        "export { PROGRESS_STAGE_META, normalizeProgressStage, progressStageLabel, nextStageOnInterview, progressStagePatch } from './src/lib/bossclaw/progressStage.ts';",
        "export { buildStatsSnapshot } from './src/lib/bossclaw/statsAggregate.ts';",
      ].join('\n'),
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'silent',
    alias: { '@': join(root, 'src') },
  });
  const M = require(outfile);

  // ===== A. 展示元数据 =====
  eq('进展阶段共 5 个', M.PROGRESS_STAGE_META.length, 5);
  eq('阶段顺序：已回复 → 已约面 → 已面试 → Offer → HR 拒绝',
    M.PROGRESS_STAGE_META.map((m) => m.key).join(','),
    'replied,interview_scheduled,interviewed,offer,rejected_by_hr');
  ok('每个阶段都有中文标签与非空提示', M.PROGRESS_STAGE_META.every((m) => m.label && m.hint));

  // ===== B. 归一化：脏数据 / 旧数据不报错 =====
  eq('undefined → null（旧数据无该字段）', M.normalizeProgressStage(undefined), null);
  eq('null → null', M.normalizeProgressStage(null), null);
  eq('空串 → null', M.normalizeProgressStage(''), null);
  eq('未知字符串 → null（不把脏值当阶段）', M.normalizeProgressStage('interviewing'), null);
  eq('合法值原样返回', M.normalizeProgressStage('offer'), 'offer');
  eq('带空白也能识别', M.normalizeProgressStage('  interviewed  '), 'interviewed');
  eq('未标记的中文口径', M.progressStageLabel(undefined), '未标记');
  eq('脏值的中文口径', M.progressStageLabel('whatever'), '未标记');
  eq('合法值的中文口径', M.progressStageLabel('rejected_by_hr'), 'HR 已拒绝');

  // ===== C. 面试邀约自动推进：只前进不后退 =====
  eq('无记录 + 约面 → 已约面', M.nextStageOnInterview(undefined), 'interview_scheduled');
  eq('已回复 + 约面 → 已约面', M.nextStageOnInterview('replied'), 'interview_scheduled');
  eq('已是已约面 → 不重复写', M.nextStageOnInterview('interview_scheduled'), null);
  eq('已面试 → 不被改回已约面', M.nextStageOnInterview('interviewed'), null);
  eq('已获 Offer → 不被改回已约面', M.nextStageOnInterview('offer'), null);
  eq('HR 已拒绝 → 不被改回已约面', M.nextStageOnInterview('rejected_by_hr'), null);
  eq('脏值按无记录处理 → 已约面', M.nextStageOnInterview('dirty'), 'interview_scheduled');

  // ===== D. 手动 patch：清除时时间戳一并清空 =====
  const cleared = M.progressStagePatch(null);
  eq('清除：progressStage 置空', cleared.progressStage, undefined);
  eq('清除：progressUpdatedAt 一并置空', cleared.progressUpdatedAt, undefined);
  const marked = M.progressStagePatch('offer');
  eq('标记：写入阶段', marked.progressStage, 'offer');
  ok('标记：带更新时间戳', typeof marked.progressUpdatedAt === 'number' && marked.progressUpdatedAt > 0);
  const dirtyPatch = M.progressStagePatch('not-a-stage');
  eq('标记脏值 → 按清除处理（不写非法枚举）', dirtyPatch.progressStage, undefined);

  // ===== E. 统计聚合：进展分布 + 漏斗面试数 =====
  const NOW = new Date('2026-11-17T12:00:00+08:00').getTime();
  const DAY = 86_400_000;
  const cfg = { pausedUntil: 0, activeHours: { enabled: false }, platforms: { boss: { enabled: true, dailyTarget: 100 } } };
  const mk = (id, extra = {}, createdAt = NOW - DAY) => ({
    id, status: 'sent', sentAt: createdAt, createdAt,
    job: { platform: 'boss', company: '某某科技', title: '前端开发' },
    ...extra,
  });

  const rows = [
    mk('a'),                                            // 旧数据：无 progressStage
    mk('b', { progressStage: 'dirty-value' }),          // 脏值
    mk('c', { progressStage: 'replied' }),
    mk('d', { progressStage: 'interview_scheduled' }),
    mk('e', { progressStage: 'interviewed' }),
    mk('f', { progressStage: 'offer' }),
    mk('g', { progressStage: 'rejected_by_hr' }),
    mk('h', { progressStage: 'offer' }, NOW - 30 * DAY), // 范围外
  ];
  const snap = M.buildStatsSnapshot({ pending: rows, taskRuns: [], directionPlan: null, config: cfg, range: '7d', now: NOW });

  eq('统计：范围内总数不含范围外岗位', snap.total, 7);
  eq('已回复计数', snap.progressStages.counts.replied, 1);
  eq('已约面计数', snap.progressStages.counts.interview_scheduled, 1);
  eq('已面试计数', snap.progressStages.counts.interviewed, 1);
  eq('Offer 计数', snap.progressStages.counts.offer, 1);
  eq('HR 拒绝计数', snap.progressStages.counts.rejected_by_hr, 1);
  eq('旧数据 + 脏值都归「未标记」', snap.progressStages.unknown, 2);
  eq('已标记条数 = 总数 - 未标记', snap.progressStages.marked, snap.total - snap.progressStages.unknown);
  eq('进展分布分母 = 范围内岗位总数', snap.progressStages.total, snap.total);
  eq('漏斗面试数 = 已约面 + 已面试 + Offer', snap.funnel.interviewCount, 3);
  eq('HR 拒绝不计入面试数（终态不是面试进展）', snap.funnel.interviewCount, 3);
  eq('进展字段不影响投递状态统计（7 条仍为 sent）', snap.counts.sent, 7);
  eq('进展字段不影响「已回复」漏斗（无 replySentAt）', snap.funnel.replied, 0);
  ok('口径说明写明面试来自 progressStage', snap.notes.some((n) => n.includes('progressStage') && n.includes('面试')));

  // 空数据：不报错、分母为 0
  const empty = M.buildStatsSnapshot({ pending: [], taskRuns: [], directionPlan: null, config: cfg, range: '7d', now: NOW });
  eq('空数据：未知为 0', empty.progressStages.unknown, 0);
  eq('空数据：面试数为 0', empty.funnel.interviewCount, 0);

  // ===== F. 源码结构守卫（类型 / 自动写入 / 展示接线）=====
  const read = (p) => readFileSync(join(root, p), 'utf8');
  const typesSrc = read('src/lib/bossclaw/types.ts');
  ok('类型：PendingItem 增加 progressStage', /progressStage\?:\s*ProgressStage/.test(typesSrc));
  ok('类型：PendingItem 增加 progressUpdatedAt', /progressUpdatedAt\?:\s*number/.test(typesSrc));
  const pendingStatusBlock = (typesSrc.match(/export type PendingStatus\s*=[\s\S]*?;/) || [''])[0];
  ok('类型：ProgressStage 是独立联合类型（不扩 PendingStatus）',
    /export type ProgressStage\s*=/.test(typesSrc) && !pendingStatusBlock.includes('interview_scheduled'),
    'PendingStatus 块：' + pendingStatusBlock.replace(/\s+/g, ' ').slice(0, 120));

  const chatSrc = read('src/store/useAutoChatStore.ts');
  const callCount = (chatSrc.match(/markProgress\(/g) || []).length;
  ok('跟聊：定义 1 处 + 至少 4 个写入点', callCount >= 5, 'count=' + callCount);
  ok('跟聊批量链路：HR 拒绝写入终态', chatSrc.includes("markProgress(item.id, 'rejected_by_hr')"));
  ok('跟聊批量链路：面试邀约写入已约面', chatSrc.includes("markProgress(item.id, 'interview_scheduled')"));
  ok('跟聊监听链路：HR 拒绝写入终态', chatSrc.includes("markProgress(matched.id, 'rejected_by_hr')"));
  ok('跟聊监听链路：面试邀约写入已约面', chatSrc.includes("markProgress(matched.id, 'interview_scheduled')"));

  const statsSrc = read('src/pages/Stats.tsx');
  ok('统计页：渲染「求职进展」卡片', statsSrc.includes('求职进展'));
  ok('统计页：进展分布取自 progressStages', statsSrc.includes('snapshot.progressStages'));
  ok('统计页：漏斗面试数取自真实字段', statsSrc.includes('snapshot.funnel.interviewCount'));

  const autoChatSrc = read('src/pages/AutoChat.tsx');
  ok('跟聊页岗位卡：手动标记入口', autoChatSrc.includes('ProgressStageSelect'));
  const workbenchSrc = read('src/pages/Workbench.tsx');
  ok('工作台岗位卡：手动标记入口', workbenchSrc.includes('ProgressStageSelect'));
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log('[求职进展回归] 通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
  for (const f of fails) console.log('  FAIL  ' + f);
  process.exit(1);
}
