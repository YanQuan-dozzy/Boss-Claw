// 上下文预算（contextBudget.ts）与超窗分片续调（oversizedContext.ts）回归断言（零新增依赖）
//
// 为什么需要它：AI 调用的「上下文投喂量」由 `模型窗口 × 用量档位` 计算得出，一旦算错方向是**静默的**——
//   · 算大了 → 超出模型实际窗口，请求直接 400（用户只看到「AI 请求失败」）；
//   · 算小了 → 长简历后半段从未进入模型，评分与打招呼语质量下降，界面却无任何异常提示；
//   · fail-safe 失效 → 老用户持久化数据缺字段时算出 Infinity / 或彻底不裁剪；
//   · 分片护栏失效 → 一次分析变成十几次调用（成本失控），或分片后总量仍超预算（等于没护栏）。
// 这些都不会被 typecheck 与构建发现，必须用断言守住。
//
// 做法：用项目里已有的 esbuild 把 TS 源打成临时 CJS 再 require，不引入任何新依赖、不改 package.json。
// `oversizedContext.ts` 依赖 AI 调用与日志 store，这里用 esbuild 插件把它们**替换为桩**，从而离线跑通
// 并直接观测「一次任务到底发起了几次调用」。
//
// 用法：node scripts/context-budget-regression.mjs   （EXIT 0 = 全通过，1 = 有失败）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** 把 `./llm` 与日志 store 换成桩：让上下文模块可离线执行，并可观测调用行为。 */
const stubPlugin = {
  name: 'stub-ai-and-logs',
  setup(b) {
    b.onResolve({ filter: /(^|\/)llm$/ }, (args) =>
      args.importer && args.importer.includes('bossclaw') ? { path: 'stub-llm', namespace: 'stub' } : null,
    );
    b.onResolve({ filter: /useRuntimeLogsStore$/ }, () => ({ path: 'stub-logs', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
      if (args.path === 'stub-logs') {
        return { loader: 'js', contents: 'export const useRuntimeLogsStore = globalThis.__logsStore;' };
      }
      return {
        loader: 'js',
        contents: [
          'export const cachedCallModel = (...a) => globalThis.__cachedCallModel(...a);',
          'export const callModel = (...a) => globalThis.__callModel(...a);',
          'export class AIError extends Error { constructor(code, message) { super(message); this.code = code; } }',
        ].join('\n'),
      };
    });
  },
};

async function loadModules() {
  const dir = mkdtempSync(join(tmpdir(), 'bossclaw-ctx-'));
  const outfile = join(dir, 'bundle.cjs');
  await build({
    stdin: {
      contents: [
        "export * from './src/lib/bossclaw/contextBudget.ts';",
        "export * from './src/lib/bossclaw/oversizedContext.ts';",
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'context-budget-regression-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile,
    logLevel: 'silent',
    plugins: [stubPlugin],
  });
  const require = createRequire(import.meta.url);
  const mod = require(outfile);
  rmSync(dir, { recursive: true, force: true });
  return mod;
}

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else failures.push(detail ? `${name} —— ${detail}` : name);
}

/** 桩：记录调用并返回可预测的文本；`fail=true` 时模拟 AI 调用失败。 */
function installStubs() {
  const state = {
    calls: [],
    fail: false,
    reply: '- 真实要点一句（保留 React / 2025.06 等具体信息）'.repeat(8),
  };
  globalThis.__logsStore = { getState: () => ({ addLog: (level, message) => state.calls.push({ log: message, level }) }) };
  globalThis.__cachedCallModel = async (messages, config, options, meta) => {
    state.calls.push({ messages, options, meta });
    if (state.fail) throw new Error('桩：模拟 AI 调用失败');
    return state.reply;
  };
  globalThis.__callModel = globalThis.__cachedCallModel;
  return state;
}

async function main(mod) {
  const {
    estimateTokens,
    resolveContextBudget,
    resolveContextWindow,
    resolveContextUsage,
    fitContext,
    fitContextToTokens,
    allocateContextBudget,
    splitContext,
    contextBudgetSignature,
    prepareContextText,
    MAX_CONDENSE_CHUNKS,
    DEFAULT_CONTEXT_WINDOW,
    CONTEXT_WINDOW_MIN,
    CONTEXT_WINDOW_MAX,
    CONTEXT_WINDOW_PRESETS,
    CONTEXT_USAGE_RATIO,
  } = mod;

  // ---- 1. token 估算：必须**保守偏高**（低估会导致超窗，是危险方向）----
  check('估算：空文本为 0', estimateTokens('') === 0);
  const cjk100 = '中'.repeat(100);
  check('估算：100 个汉字 ≥ 100 token（保守偏高）', estimateTokens(cjk100) >= 100, `实际 ${estimateTokens(cjk100)}`);
  const ascii100 = 'a'.repeat(100);
  const asciiTokens = estimateTokens(ascii100);
  check('估算：100 个英文字符 ≥ 25 token（保守偏高）', asciiTokens >= 25, `实际 ${asciiTokens}`);
  check('估算：中英混排不减少', estimateTokens(`中文${ascii100}中文`) > asciiTokens);

  // ---- 2. fail-safe 与窗口下限 ----
  check('fail-safe：undefined 窗口 → 默认值', resolveContextWindow(undefined) === DEFAULT_CONTEXT_WINDOW);
  check('fail-safe：0 窗口 → 默认值', resolveContextWindow({ contextWindow: 0 }) === DEFAULT_CONTEXT_WINDOW);
  check('fail-safe：NaN 窗口 → 默认值', resolveContextWindow({ contextWindow: NaN }) === DEFAULT_CONTEXT_WINDOW);
  check('fail-safe：负窗口 → 默认值', resolveContextWindow({ contextWindow: -5 }) === DEFAULT_CONTEXT_WINDOW);
  check('下限：窗口最小值为 32K', CONTEXT_WINDOW_MIN === 32_000, `实际 ${CONTEXT_WINDOW_MIN}`);
  check(
    '下限：低于最小值的输入被抬到下限',
    resolveContextWindow({ contextWindow: 1000 }) === CONTEXT_WINDOW_MIN,
  );
  check(
    '下限：预设表不含低于最小值的档位（否则 UI 会出现「选了却被抬走」的选项）',
    CONTEXT_WINDOW_PRESETS.every((p) => p.value >= CONTEXT_WINDOW_MIN),
    `最小预设 ${Math.min(...CONTEXT_WINDOW_PRESETS.map((p) => p.value))}`,
  );
  check('下限：预设表内置 32K 档', CONTEXT_WINDOW_PRESETS.some((p) => p.value === 32_000));
  check('下限：默认窗口不低于最小值', DEFAULT_CONTEXT_WINDOW >= CONTEXT_WINDOW_MIN);
  check('fail-safe：窗口上限收敛', resolveContextWindow({ contextWindow: 999_999_999 }) === CONTEXT_WINDOW_MAX);
  check('fail-safe：非法档位 → full', resolveContextUsage({ contextUsage: 'xxx' }) === 'full');
  check('fail-safe：缺失档位 → full', resolveContextUsage(undefined) === 'full');
  check('fail-safe：compact 被识别', resolveContextUsage({ contextUsage: 'compact' }) === 'compact');
  const noConfigBudget = resolveContextBudget(undefined);
  check(
    'fail-safe：无配置时的输入预算有限且为正',
    Number.isFinite(noConfigBudget.inputBudgetTokens) && noConfigBudget.inputBudgetTokens > 0,
    `实际 ${noConfigBudget.inputBudgetTokens}`,
  );
  check('fail-safe：无配置时标记 windowConfigured=false', noConfigBudget.windowConfigured === false);

  // ---- 3. 预算口径：输入 + 输出 + 安全边际 不得超过窗口用量 ----
  for (const [windowTokens, usage] of [
    [1_000_000, 'full'],
    [252_000, 'full'],
    [128_000, 'compact'],
    [64_000, 'compact'],
    [32_000, 'compact'],
    [16_000, 'full'], // 低于下限：会被 clamp 到 32K；断言按 clamp 后的实际窗口校验
  ]) {
    const model = { contextWindow: windowTokens, contextUsage: usage };
    const b = resolveContextBudget(model, { outputTokens: 3200 });
    const consumed = b.inputBudgetTokens + b.outputReserveTokens + b.safetyMarginTokens;
    const limit = Math.floor(resolveContextWindow(model) * CONTEXT_USAGE_RATIO[usage]);
    check(`预算不超窗：${windowTokens}/${usage}`, consumed <= limit, `已用 ${consumed} > 上限 ${limit}`);
  }
  check(
    '预算：窗口越大小预算越大（单调）',
    resolveContextBudget({ contextWindow: 1_000_000, contextUsage: 'full' }).inputBudgetTokens >
      resolveContextBudget({ contextWindow: 128_000, contextUsage: 'full' }).inputBudgetTokens,
  );

  // ---- 4. 40% 档确实显著小于全满（用户可见承诺，不能被实现悄悄改掉）----
  const full = resolveContextBudget({ contextWindow: 200_000, contextUsage: 'full' }, { outputTokens: 4000 });
  const compact = resolveContextBudget({ contextWindow: 200_000, contextUsage: 'compact' }, { outputTokens: 4000 });
  const ratio = compact.inputBudgetTokens / full.inputBudgetTokens;
  check('档位：40% 档预算显著小于全满', ratio < 0.5, `实际比例 ${ratio.toFixed(3)}`);
  check('档位：40% 档仍保留可用预算', compact.inputBudgetTokens > 3000, `实际 ${compact.inputBudgetTokens}`);

  // ---- 5. fitContext：短文本零改动；长文本被裁且不超预算 ----
  const small = '这是一段很短的简历片段';
  const shortModel = { contextWindow: 128_000, contextUsage: 'full' };
  check('裁剪：短文本原样返回（不多余改写）', fitContext(small, shortModel) === small);

  const longResume = '个人项目经历描述。'.repeat(40_000); // 约 72 万字符
  const tinyModel = { contextWindow: 32_000, contextUsage: 'compact' };
  const fitted = fitContext(longResume, tinyModel, { outputTokens: 3200 });
  const budget = resolveContextBudget(tinyModel, { outputTokens: 3200 }).inputBudgetTokens;
  check('裁剪：长文本确实被裁短', fitted.length < longResume.length);
  check(
    '裁剪：裁剪后不超预算（关键红线）',
    estimateTokens(fitted) <= budget,
    `裁剪后 ${estimateTokens(fitted)} token > 预算 ${budget}`,
  );
  check('裁剪：带省略标记，模型可知内容被截断', fitted.includes('省略'));

  const fullFitted = fitContext(longResume, { contextWindow: 200_000, contextUsage: 'full' }, { outputTokens: 4096 });
  const shareFitted = fitContext(longResume, { contextWindow: 200_000, contextUsage: 'full' }, { outputTokens: 4096, share: 0.4 });
  check(
    '裁剪：share 生效（0.4 份额明显短于满额）',
    shareFitted.length < fullFitted.length * 0.6,
    `share=${shareFitted.length} full=${fullFitted.length}`,
  );
  check(
    '裁剪：非法 share 回退为 1',
    fitContext(longResume, shortModel, { share: NaN }).length === fitContext(longResume, shortModel).length,
  );
  check('裁剪：token 上限为 0 时返回空', fitContextToTokens(longResume, 0) === '');

  // ---- 6. 多段共享预算：各段之和不得超过总预算（否则凑起来仍会超窗）----
  const weights = { resume: 0.45, job: 0.4, profile: 0.15 };
  const alloc = allocateContextBudget({ contextWindow: 128_000, contextUsage: 'full' }, weights, { outputTokens: 3200 });
  const allocTotal = alloc.resume + alloc.job + alloc.profile;
  const allocBudget = resolveContextBudget({ contextWindow: 128_000, contextUsage: 'full' }, { outputTokens: 3200 }).inputBudgetTokens;
  check('分配：各段之和不超过总预算', allocTotal <= allocBudget, `合计 ${allocTotal} > 预算 ${allocBudget}`);
  check('分配：份额大的段拿到更多', alloc.resume > alloc.job && alloc.job > alloc.profile);
  check(
    '分配：权重合计为 0 时全部为 0（不产生无界值）',
    Object.values(allocateContextBudget(shortModel, { a: 0, b: -1 })).every((v) => v === 0),
  );

  // ---- 7. 签名：窗口/档位变化必须改变签名（否则切档后命中旧缓存，开关形同失效）----
  const sigA = contextBudgetSignature({ contextWindow: 128_000, contextUsage: 'full' });
  const sigB = contextBudgetSignature({ contextWindow: 128_000, contextUsage: 'compact' });
  const sigC = contextBudgetSignature({ contextWindow: 200_000, contextUsage: 'full' });
  check('签名：档位变化 → 签名变化', sigA !== sigB);
  check('签名：窗口变化 → 签名变化', sigA !== sigC);
  check(
    '签名：同输入稳定（保证缓存可命中）',
    sigA === contextBudgetSignature({ contextWindow: 128_000, contextUsage: 'full' }),
  );
  check('签名：缺失配置有确定值', typeof contextBudgetSignature(undefined) === 'string');

  // ---- 8. splitContext：切分不丢内容、每片不超上限 ----
  // 片间被 trim 掉的只有空白，故按「去空白后等长」校验不丢内容
  const stripWs = (s) => s.replace(/\s+/g, '');

  const midText = '项目经历描述。'.repeat(3000); // 常规规模：不触及 64 片保护上限
  const midPieces = splitContext(midText, 5000);
  check('分片：长文本切为多片', midPieces.length > 1, `实际 ${midPieces.length} 片`);
  check(
    '分片：常规规模下每片不超上限',
    midPieces.every((p) => estimateTokens(p) <= 5000),
    `最大片 ${Math.max(...midPieces.map(estimateTokens))}`,
  );
  check('分片：常规规模下不丢内容', stripWs(midPieces.join('')) === stripWs(midText));

  // 极端规模：片数会触及 64 片保护上限 —— 此时**宁可最后一片超限也不能丢内容**（分片不能退化成截断）
  const hugePieces = splitContext(longResume, 5000);
  check('分片：片数受保护上限约束（防异常输入炸出海量分片）', hugePieces.length <= 64, `实际 ${hugePieces.length}`);
  check(
    '分片：触及片数上限时仍不丢弃剩余内容（关键红线）',
    stripWs(hugePieces.join('')) === stripWs(longResume),
    `${stripWs(hugePieces.join('')).length} vs ${stripWs(longResume).length}`,
  );

  check('分片：短文本单片返回', splitContext('短文本', 5000).length === 1);
  check('分片：非法上限不切分', splitContext('短文本', 0).length === 1);
  check('分片：空文本返回空数组', splitContext('', 5000).length === 0);

  // ---- 9. prepareContextText：预算内零额外调用；超窗分片且守住护栏；失败回落截断 ----
  const stubs = installStubs();
  const ctxOpts = { focus: '测试焦点', cacheScope: 'job-analysis', purpose: '回归测试' };
  const aiCalls = () => stubs.calls.filter((c) => c.messages);

  const within = await prepareContextText('很短的简历', shortModel, { ...ctxOpts, tokenBudget: 100_000 });
  check('分片续调：预算内原样返回', within.text === '很短的简历' && within.condensed === false);
  check('分片续调：预算内零额外调用（不产生成本）', aiCalls().length === 0);

  stubs.calls.length = 0;
  const huge = '项目经历与实习经历描述。'.repeat(20_000); // 远超预算
  const smallBudget = 1000;
  // 用小窗口模型逼出「片数 > 护栏」的路径（32K + 40% 档 → 单片输入预算小 → 片数多）
  const hugeModel = { contextWindow: 32_000, contextUsage: 'compact' };
  const condensed = await prepareContextText(huge, hugeModel, { ...ctxOpts, tokenBudget: smallBudget });
  check('分片续调：超窗触发分片', condensed.condensed === true, JSON.stringify(condensed));
  check('护栏：分片上限为 3', MAX_CONDENSE_CHUNKS === 3);
  check('护栏：实际片数不超过上限', condensed.chunks <= MAX_CONDENSE_CHUNKS, `实际 ${condensed.chunks} 片`);
  check('护栏：额外调用次数 == 片数（一次任务最多 3 次）', aiCalls().length === condensed.chunks, `调用 ${aiCalls().length} 次`);
  check('护栏：超长文本报告被丢弃的片数', condensed.droppedChunks > 0, `dropped=${condensed.droppedChunks}`);
  check(
    '护栏：合并结果二次裁剪后不超预算',
    estimateTokens(condensed.text) <= smallBudget,
    `实际 ${estimateTokens(condensed.text)} > ${smallBudget}`,
  );
  check('分片续调：每片都是独立请求（不携带前文，即「新开对话」）', aiCalls().every((c) => c.messages.length === 2));

  stubs.calls.length = 0;
  stubs.fail = true;
  const fellBack = await prepareContextText(huge, hugeModel, { ...ctxOpts, tokenBudget: smallBudget });
  check('回落：提炼失败 → 退回截断（condensed=false）', fellBack.condensed === false);
  check('回落：给出失败原因', Boolean(fellBack.fallbackReason));
  check(
    '回落：结果同样不超预算',
    estimateTokens(fellBack.text) <= smallBudget,
    `实际 ${estimateTokens(fellBack.text)}`,
  );
  stubs.fail = false;

  // transform 模式（简历整理类保真任务）：逐片用调用方指令完整处理，而非提炼要点
  stubs.calls.length = 0;
  const instruction = '把本片整理成工整的简历正文';
  const transformed = await prepareContextText(huge, hugeModel, {
    ...ctxOpts,
    tokenBudget: smallBudget,
    mode: 'transform',
    instruction,
  });
  check('transform：超窗时逐片处理', transformed.condensed === true && transformed.chunks >= 1);
  check(
    'transform：system 使用调用方指令（不是提炼指令）',
    aiCalls().every((c) => c.messages[0].content === instruction),
  );

  stubs.calls.length = 0;
  await prepareContextText(huge, hugeModel, { ...ctxOpts, tokenBudget: smallBudget });
  check(
    'extract：system 使用提炼指令（含「真实存在的事实」约束）',
    aiCalls().every((c) => String(c.messages[0].content).includes('真实存在')),
  );

  check(
    '边界：空文本零调用',
    (await prepareContextText('', shortModel, { ...ctxOpts, tokenBudget: 500 })).text === '',
  );
  check(
    '边界：预算为 0 返回空（不炸）',
    (await prepareContextText('内容', shortModel, { ...ctxOpts, tokenBudget: 0 })).text === '',
  );
}

const mod = await loadModules();
await main(mod);

console.log(`[上下文预算回归] 通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
