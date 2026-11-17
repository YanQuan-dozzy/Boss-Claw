// 网关模型能力动态探测（modelCapabilities.ts / capabilitiesStore.ts）回归断言（零新增依赖）
//
// 为什么需要它：这是「动态能力发现」替代硬编码白名单（thinkingCapability.ts）的核心路径——
//   探测解析一旦退化，后果是**静默的**：网关明明支持思考，BossClaw 却仍显示「该模型不支持思考」，
//   开关打不开、请求不带思考参数；或反过来，解析器把不支持的模型误判成支持 → 发错参数 400。
//   这些不会被 typecheck / build 发现（纯运行时逻辑），必须用断言守住。
//
// 重点守卫（相对硬编码时代的升级）：
//   · 解析器容忍真实网关边界情况（网关实测）：modalities=null、reasoning_levels=[]、
//     supported_reasoning_levels=[{effort:"low"},…] 对象数组、上下文窗口字段名不统一；
//   · stripOrgPrefix 覆盖 auto/ 路由分组（用户填 "model-a"，网关 id 是 "auto/model-a"）；
//   · 探测成功 → 思考开关可用（thinkingCapability 不再一概判 unsupported）；
//   · 探测失败 / 未声明 → fail-safe 回落到静态判定（不发未验证参数）；
//   · 失败不缓存（可重试）；成功持久化（跨重启生效）。
//
// 做法：与 context-budget-regression.mjs 一致，用项目内 esbuild 打 TS 为临时 CJS。
// capabilitiesStore.ts 依赖 electronApi（渲染层封装）与 localStorage（持久化），
// 这里把 electronApi 替换为桩、localStorage 给内存实现。
//
// 用法：node scripts/model-capabilities-regression.mjs   （EXIT 0 = 全通过，1 = 有失败）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

// capabilitiesStore 模块加载时 hydrate() 会读 localStorage；给最小内存实现。
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
  key: (i) => Array.from(store.keys())[i] ?? null,
  get length() { return store.size; },
};

// electronApi.modelsProbe 打桩：可编程返回 /v1/models 原文或错误。
const stubPlugin = {
  name: 'stub-electron-api',
  setup(b) {
    b.onResolve({ filter: /electronApi$/ }, () => ({ path: 'stub-electron-api', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      loader: 'js',
      contents: [
        'export const electronApi = {',
        '  modelsProbe: async (url, apiKey, timeoutMs) => {',
        '    globalThis.__probeCalls.push({ url, apiKey, timeoutMs });',
        '    if (globalThis.__probeConfig.fail) { throw new Error("网络失败（桩）"); }',
        '    return { ok: globalThis.__probeConfig.ok, status: globalThis.__probeConfig.status, text: globalThis.__probeConfig.text, error: "" };',
        '  },',
        '};',
      ].join('\n'),
    }));
  },
};

const dir = mkdtempSync(join(tmpdir(), 'bossclaw-cap-'));
const outfile = join(dir, 'bundle.cjs');
let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; return; }
  fails.push(name + (detail ? '  → ' + detail : ''));
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}

try {
  await build({
    stdin: {
      contents: [
        "export * from './src/lib/bossclaw/modelCapabilities.ts';",
        "export * from './src/lib/bossclaw/capabilitiesStore.ts';",
        "export * from './src/lib/bossclaw/thinkingCapability.ts';",
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
    plugins: [stubPlugin],
  });

  globalThis.__probeCalls = [];
  globalThis.__probeConfig = { ok: true, status: 200, text: '[]', fail: false };
  const mod = require(outfile);

  const {
    parseModelEntry,
    parseModelCapabilitiesResponse,
    findModelCapability,
    stripOrgPrefix,
    thinkingProfileFromDiscovered,
    resolveThinkingProfile,
    getCachedCapability,
    probeModelCapabilities,
    listGatewayModels,
    invalidateCapabilitiesCache,
  } = mod;

  // ===== A. stripOrgPrefix：剥首段路由分组 =====
  eq('stripOrgPrefix：auto/ 前缀剥除', stripOrgPrefix('auto/model-a'), 'model-a');
  eq('stripOrgPrefix：组织/模型全名剥除', stripOrgPrefix('vendor/Model-A'), 'Model-A');
  eq('stripOrgPrefix：无前缀原样', stripOrgPrefix('deepseek-flash'), 'deepseek-flash');
  eq('stripOrgPrefix：空串安全', stripOrgPrefix(''), '');
  eq('stripOrgPrefix：多段只剥首段', stripOrgPrefix('a/b/c'), 'b/c');

  // ===== B. parseModelEntry：真实网关样本的边界情况 =====
  const m31 = parseModelEntry({
    id: 'auto/model-a',
    context_length: 300000,
    context_window: 300000,
    max_input_tokens: 300000,
    reasoning: true,
    reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }],
    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
    tool_call: true,
    supported_parameters: ['tools', 'tool_choice', 'reasoning'],
    display_name: 'Model-A',
  });
  ok('解析：auto/ 前缀模型被识别', m31 !== null);
  if (m31) {
    eq('解析：上下文窗口取 context_length', m31.contextWindow, 300000);
    eq('解析：reasoning 声明被识别', m31.reasoning, true);
    eq('解析：思考等级取对象数组的 effort', m31.reasoningLevels.join(','), 'low,medium,high,xhigh,max');
    eq('解析：输入模态含 image', m31.inputModalities.join(','), 'text,image,video');
    eq('解析：输出模态', m31.outputModalities.join(','), 'text');
    eq('解析：工具调用声明', m31.toolCall, true);
    eq('解析：展示名', m31.displayName, 'Model-A');
  }

  const nonReasoning = parseModelEntry({
    id: 'workbuddy/hy3-x',
    context_length: 300000,
    reasoning: false,
    reasoning_levels: [],
    supported_parameters: ['tools', 'tool_choice'],
    modalities: null,
    tool_call: true,
  });
  ok('解析：非推理模型被识别', nonReasoning !== null);
  if (nonReasoning) {
    eq('解析：reasoning=false 正确', nonReasoning.reasoning, false);
    eq('解析：空等级列表', nonReasoning.reasoningLevels.length, 0);
    eq('解析：modalities=null 容错为 []', nonReasoning.inputModalities.length + nonReasoning.outputModalities.length, 0);
    eq('解析：supported_parameters 含 tools → 工具可用', nonReasoning.toolCall, true);
  }

  const imageModel = parseModelEntry({
    id: 'vendor/Model-Image',
    context_length: 400000,
    reasoning: false,
    modalities: { input: ['text', 'image'], output: ['image'] },
    max_output_tokens: 32000,
  });
  ok('解析：图像模型被识别', imageModel !== null);
  if (imageModel) {
    eq('解析：图像模型输出模态', imageModel.outputModalities.join(','), 'image');
    eq('解析：图像模型无工具声明', imageModel.toolCall, false);
  }

  eq('解析：字符串数组形式的等级也支持', parseModelEntry({
    id: 'x/y',
    reasoning: true,
    supported_reasoning_levels: ['low', 'high'],
  })?.reasoningLevels.join(','), 'low,high');
  eq('解析：缺 id 返回 null', parseModelEntry({ name: 'no-id' }), null);
  eq('解析：null 条目返回 null', parseModelEntry(null), null);
  eq('解析：字符串数组形式的窗口字段', parseModelEntry({ id: 'z', max_input_tokens: 16000 })?.contextWindow, 16000);

  // ===== C. parseModelCapabilitiesResponse：信封兼容 =====
  {
    const full = parseModelCapabilitiesResponse(JSON.stringify({ data: [
      { id: 'a', context_length: 1000, reasoning: false },
      { id: 'b', context_length: 2000, reasoning: true, reasoning_levels: ['low'] },
    ] }));
    eq('信封：{data:[…]} 解析成功', full.ok, true);
    eq('信封：模型计数', full.count, 2);
    ok('信封：按 id 索引', full.byId.has('a') && full.byId.has('b'));

    const bare = parseModelCapabilitiesResponse(JSON.stringify([{ id: 'a', context_length: 1, reasoning: false }]));
    eq('信封：直接数组也支持', bare.ok, true);
    eq('信封：直接数组计数', bare.count, 1);

    const badJson = parseModelCapabilitiesResponse('not json');
    eq('信封：非法 JSON → ok=false', badJson.ok, false);
    const noData = parseModelCapabilitiesResponse(JSON.stringify({ models: [] }));
    eq('信封：缺 data → ok=false', noData.ok, false);
    const someBad = parseModelCapabilitiesResponse(JSON.stringify({ data: [{ id: 'good', context_length: 1 }, { name: 'bad' }] }));
    eq('信封：部分坏条目仍整体成功', someBad.ok, true);
    eq('信封：坏条目被跳过', someBad.count, 1);
  }

  // ===== D. findModelCapability：先精确、再剥前缀 =====
  {
    const byId = parseModelCapabilitiesResponse(JSON.stringify({ data: [{ id: 'auto/model-a', context_length: 300000, reasoning: true, reasoning_levels: ['high'] }] })).byId;
    const exact = findModelCapability(byId, 'auto/model-a');
    const stripped = findModelCapability(byId, 'model-a');
    const miss = findModelCapability(byId, 'model-m3');
    eq('查找：精确 id 命中', exact?.id, 'auto/model-a');
    eq('查找：剥前缀命中（auto/ 路由组）', stripped?.id, 'auto/model-a');
    eq('查找：不存在的模型 → null', miss, null);
    eq('查找：空名 → null', findModelCapability(byId, ''), null);
  }

  // ===== E. 探测集成：成功 → 能力可用且缓存生效；失败 → 不缓存可重试 =====
  globalThis.__probeConfig.text = JSON.stringify({ data: [{ id: 'auto/model-a', context_length: 300000, reasoning: true, reasoning_levels: ['low', 'high'] }] });
  const r1 = await probeModelCapabilities('http://127.0.0.1:11434/v1', 'model-a', '');
  ok('探测：成功', r1.ok && r1.capability !== null, JSON.stringify(r1));
  eq('探测：剥前缀找到能力', r1.capability?.reasoning, true);
  ok('探测：调用次数为 1（首次真实探测）', globalThis.__probeCalls.length === 1);
  ok('探测：models 携带网关全部模型 id', r1.models.includes('auto/model-a') && r1.models.length === 1, `实际 ${JSON.stringify(r1.models)}`);
  const r1again = await probeModelCapabilities('http://127.0.0.1:11434/v1', 'model-a', '');
  ok('探测：缓存命中（不重复调用）', globalThis.__probeCalls.length === 1, `实际 ${globalThis.__probeCalls.length} 次`);
  ok('探测：二次返回与首次一致', r1again.ok && r1again.capability?.reasoning === true);
  ok('探测：缓存命中时 models 仍可用', r1again.models.includes('auto/model-a'));
  ok('探测：缓存能力经 getCachedCapability 可读', getCachedCapability('http://127.0.0.1:11434/v1', 'model-a')?.reasoning === true);

  invalidateCapabilitiesCache('http://127.0.0.1:11434/v1', 'model-a');
  globalThis.__probeCalls.length = 0;
  globalThis.__probeConfig.fail = true;
  const rFail = await probeModelCapabilities('http://127.0.0.1:11434/v1', 'model-a', '');
  ok('探测：网络失败 → ok=false', rFail.ok === false);
  ok('探测：失败时 models 为空数组', Array.isArray(rFail.models) && rFail.models.length === 0);
  ok('探测：失败后缓存不可读（可重试）', getCachedCapability('http://127.0.0.1:11434/v1', 'model-a') === null);
  globalThis.__probeCalls.length = 0;
  globalThis.__probeConfig.fail = false;
  const rRetry = await probeModelCapabilities('http://127.0.0.1:11434/v1', 'model-a', '');
  ok('探测：失败后重试可成功', rRetry.ok && rRetry.capability?.reasoning === true);
  ok('探测：失败重试确实是新请求（非缓存）', globalThis.__probeCalls.length >= 1);

  // 模型名不在网关列表：ok=false + notes 说明，且不缓存
  // 用从未探测过的模型名，避免命中上面成功路径留下的缓存（该键上次成功已持久化）
  globalThis.__probeConfig.text = JSON.stringify({ data: [{ id: 'other-model', context_length: 1, reasoning: false }] });
  globalThis.__probeCalls.length = 0;
  const rMiss = await probeModelCapabilities('http://127.0.0.1:11434/v1', 'model-b', '');
  ok('探测：列表内未找到 → ok=false', rMiss.ok === false);
  ok('探测：未找到有说明', rMiss.notes.some((n) => n.includes('未找到')));
  ok('探测：未找到不缓存', getCachedCapability('http://127.0.0.1:11434/v1', 'model-b') === null);

  // ===== E2. listGatewayModels：候选列表不依赖已填模型名（修复「先填名才能选」死锁）=====
  {
    const fresh = 'http://127.0.0.1:1111/v1';
    globalThis.__probeConfig.ok = true;
    globalThis.__probeConfig.status = 200;
    globalThis.__probeConfig.fail = false;
    globalThis.__probeConfig.text = JSON.stringify({ data: [{ id: 'auto/model-a' }, { id: 'auto/model-c' }] });
    globalThis.__probeCalls.length = 0;
    const list = await listGatewayModels(fresh, '');
    ok('列表：空模型名也能拉到候选', list.length === 2 && list.includes('auto/model-c'), JSON.stringify(list));
    ok('列表：首次真实请求 1 次', globalThis.__probeCalls.length === 1);
    const listAgain = await listGatewayModels(fresh, '');
    ok('列表：内存缓存命中（不重复请求）', globalThis.__probeCalls.length === 1 && listAgain.length === 2);

    // 同 baseUrl 已成功探测过能力 → 直接复用能力缓存里的全量列表，不发请求
    globalThis.__probeCalls.length = 0;
    const listCached = await listGatewayModels('http://127.0.0.1:11434/v1', '');
    ok('列表：复用能力缓存的全量 models', listCached.includes('auto/model-a'), JSON.stringify(listCached));
    ok('列表：复用缓存时不再发请求', globalThis.__probeCalls.length === 0);

    // 失败 → 空数组（保持手输可用），失败不缓存、可重试
    globalThis.__probeConfig.fail = true;
    globalThis.__probeCalls.length = 0;
    const listFail = await listGatewayModels('http://127.0.0.1:2222/v1', '');
    ok('列表：网络失败 → 空数组', Array.isArray(listFail) && listFail.length === 0);
    globalThis.__probeConfig.fail = false;
    const listRetry = await listGatewayModels('http://127.0.0.1:2222/v1', '');
    ok('列表：失败后重试成功', listRetry.length >= 1, JSON.stringify(listRetry));
  }

  // ===== F. 思考判定联动：探测结果替代硬编码 =====
  {
    const cap = { reasoning: true, reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'] };
    const prof = thinkingProfileFromDiscovered(cap);
    eq('联动：探测到思考 → toggleable', prof.mode, 'toggleable');
    eq('联动：on 片段（thinking.enabled）', JSON.stringify(prof.on), JSON.stringify({ thinking: { type: 'enabled' } }));
    eq('联动：off 片段（thinking.disabled）', JSON.stringify(prof.off), JSON.stringify({ thinking: { type: 'disabled' } }));
    eq('联动：强度档来自网关声明', prof.efforts.join(','), 'low,medium,high,xhigh,max');
    eq('联动：默认档取 medium（若提供）', prof.defaultEffort, 'medium');
    eq('联动：强度字段 reasoning_effort', prof.effortField, 'reasoning_effort');

    const noLevels = thinkingProfileFromDiscovered({ reasoning: true, reasoningLevels: [] });
    eq('联动：无等级也能开关（不判不支持）', noLevels.mode, 'toggleable');
    eq('联动：无等级时不可调档', noLevels.efforts.length, 0);

    const noReasoning = thinkingProfileFromDiscovered({ reasoning: false });
    eq('联动：网关未声明思考 → 仍 unsupported（fail-safe）', noReasoning.mode, 'unsupported');
  }

  // resolveThinkingProfile：前缀未命中 + discovered → 用探测结果；无 discovered → 仍旧 unsupported
  {
    const cap = { reasoning: true, reasoningLevels: ['low', 'high'] };
    const viaDiscovered = resolveThinkingProfile('custom', 'model-a', 'http://127.0.0.1:11434/v1', cap);
    eq('resolve：custom + discovered → toggleable', viaDiscovered.mode, 'toggleable');
    eq('resolve：custom + discovered → 等级', viaDiscovered.efforts.join(','), 'low,high');
    const noCap = resolveThinkingProfile('custom', 'model-a', 'http://127.0.0.1:11434/v1');
    eq('resolve：custom 无探测 → 仍旧 unsupported（fail-safe）', noCap.mode, 'unsupported');
    const deepseekStill = resolveThinkingProfile('deepseek', 'deepseek-flash', 'https://api.deepseek.com', cap);
    eq('resolve：已识别的服务商优先于探测（deepseek 仍 toggleable）', deepseekStill.mode, 'toggleable');
    eq('resolve：deepseek 用自己的强度档', deepseekStill.efforts.join(','), 'low,high,max');
  }

  // ===== G. 持久化：成功结果跨「重启」（重载模块后 hydrate）写入 localStorage =====
  {
    const persistedRaw = store.get('bossclaw-model-capabilities');
    ok('持久化：成功结果写入 localStorage', Boolean(persistedRaw));
    if (persistedRaw) {
      const parsed = JSON.parse(persistedRaw);
      eq('持久化：版本号正确', parsed.version, 1);
      ok('持久化：条目含上次成功的能力', parsed.entries.some((e) => e.modelName === 'model-a' && e.ok));
    }
    // 重载模块：从持久化恢复（不触发网络）
    globalThis.__probeCalls.length = 0;
    delete require.cache[outfile];
    const mod2 = require(outfile);
    const cached = mod2.getCachedCapability('http://127.0.0.1:11434/v1', 'model-a');
    ok('持久化：重载后从 localStorage 恢复（不发网络请求）', cached?.reasoning === true && globalThis.__probeCalls.length === 0);
    // 重载后再次探测：走缓存路径，models 依旧携带
    const rReloaded = await mod2.probeModelCapabilities('http://127.0.0.1:11434/v1', 'model-a', '');
    ok('持久化：重载后探测仍返回 models（缓存命中）', rReloaded.ok && rReloaded.models.includes('auto/model-a'));
  }
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

if (fails.length) {
  console.error(`model-capabilities regression: ${pass} passed, ${fails.length} failed`);
  for (const fail of fails) console.error('FAIL ' + fail);
  process.exitCode = 1;
} else {
  console.log(`model-capabilities regression: ${pass}/${pass} passed`);
}
