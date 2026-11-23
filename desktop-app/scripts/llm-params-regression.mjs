// LLM 请求参数口径回归（issue #28）
//
// 现象：OpenAI 新一代模型（gpt-5.x / gpt-6 / o 系列）把输出长度参数从 `max_tokens` 改名成
// `max_completion_tokens`，而 llm.ts 把字段名写死成前者 → 设置页「测试连接」直接 400：
//   Unsupported parameter: 'max_tokens' is not supported with this model.
//   Use 'max_completion_tokens' instead.
// 类型检查、构建都发现不了这类问题（字段名是字符串），只能在「请求体真的长什么样」上断言。
//
// 本脚本守住四件事：
//   A. 静态口径：可判定的模型名直接发 max_completion_tokens，其余仍发 max_tokens（不误伤 DeepSeek/通义等）；
//   B. 运行时纠偏：服务端点名某个字段不支持时，请求体被正确改写（双向）且不误改无关报错；
//   C. 会话记忆：纠偏结论被记住，后续调用不再重复撞 400；
//   D. 端到端：callModel 的首次请求 / 纠偏重试 / JSON 补齐（repairJsonViaModel）三处都用同一口径
//      —— 补齐那处此前也写死了 max_tokens，会在 gpt-5.x 上静默失败（返回 null → 结果作废）。
//
// 用法：node scripts/llm-params-regression.mjs   （EXIT 0 = 全通过，1 = 有失败）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

// zustand persist / 运行时日志在模块加载时会读浏览器环境；给最小内存实现。
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
  key: (i) => Array.from(store.keys())[i] ?? null,
  get length() { return store.size; },
};
globalThis.window = { addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, dispatchEvent() {} };
globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; return; }
  fails.push(name + (detail ? '  → ' + detail : ''));
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}

// ---- 载入待测模块：electronApi 用桩替掉（llm.ts 经它走主进程代理） ----
const ELECTRON_API_STUB = `
export const electronApi = {
  llmProxy: (...args) => globalThis.__llmProxy(...args),
};
`;

const dir = mkdtempSync(join(tmpdir(), 'bossclaw-llmparams-'));
const outfile = join(dir, 'bundle.cjs');
let M;
try {
  await build({
    stdin: {
      contents: [
        "export * from './src/lib/bossclaw/modelParams.ts';",
        "export { callModel } from './src/lib/bossclaw/llm.ts';",
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
    plugins: [{
      name: 'stub-electron-api',
      setup(b) {
        b.onResolve({ filter: /^@\/lib\/electronApi$/ }, () => ({ path: 'electron-api-stub', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: ELECTRON_API_STUB, loader: 'js' }));
      },
    }],
  });
  M = require(outfile);
} catch (e) {
  console.error('[LLM 参数口径回归] 载入模块失败：' + (e?.message || e));
  process.exit(1);
}

// ===== A. 静态口径 =====
{
  eq('gpt-5.6-luna（issue 复现模型）→ max_completion_tokens', M.defaultOutputTokenField('gpt-5.6-luna'), 'max_completion_tokens');
  eq('gpt-6-astra → max_completion_tokens', M.defaultOutputTokenField('gpt-6-astra'), 'max_completion_tokens');
  eq('o3-mini → max_completion_tokens', M.defaultOutputTokenField('o3-mini'), 'max_completion_tokens');
  eq('大小写无关 → max_completion_tokens', M.defaultOutputTokenField('GPT-5.5-Pro'), 'max_completion_tokens');
  eq('deepseek-flash 仍用 max_tokens', M.defaultOutputTokenField('deepseek-flash'), 'max_tokens');
  eq('glm-5.3 仍用 max_tokens', M.defaultOutputTokenField('glm-5.3'), 'max_tokens');
  eq('组织/模型名只按末段判断（Qwen3.8 → max_tokens）', M.defaultOutputTokenField('Qwen/Qwen3.8-2.4T-A95B'), 'max_tokens');
  eq('未配置模型 → max_tokens（不猜）', M.defaultOutputTokenField(''), 'max_tokens');
  eq('undefined → max_tokens（不猜）', M.defaultOutputTokenField(undefined), 'max_tokens');

  const plan = M.resolveModelParamPlan('openai', 'gpt-5.6-luna', 'https://api.openai.com/v1');
  eq('plan：gpt-5.6 的字段名', plan.tokenField, 'max_completion_tokens');
  eq('plan：默认允许 temperature', plan.supportsTemperature, true);
}

// ===== B. 运行时纠偏（纯函数） =====
{
  const ISSUE_BODY = JSON.stringify({
    error: {
      message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
      type: 'invalid_request_error',
      param: 'max_tokens',
      code: 'unsupported_parameter',
    },
  });

  // 未知模型（静态表判不出）首次仍发 max_tokens，靠这条纠偏救回来
  const legacy = { model: 'gpt-9-preview', temperature: 0.1, max_tokens: 128, response_format: { type: 'json_object' } };
  const key = M.modelParamKey('custom', 'gpt-9-preview', 'https://api.openai.com/v1');
  const fixed = M.adaptPayloadToError(legacy, 400, ISSUE_BODY, key);
  ok('纠偏：返回了改写后的请求体', Boolean(fixed));
  eq('纠偏：字段名改为 max_completion_tokens', fixed?.max_completion_tokens, 128);
  eq('纠偏：不留 max_tokens', Object.prototype.hasOwnProperty.call(fixed || {}, 'max_tokens'), false);
  eq('纠偏：其余字段原样保留（temperature）', fixed?.temperature, 0.1);
  eq('纠偏：response_format 未被牵连', JSON.stringify(fixed?.response_format), JSON.stringify({ type: 'json_object' }));

  const learned = M.resolveModelParamPlan('custom', 'gpt-9-preview', 'https://api.openai.com/v1');
  eq('会话记忆：同一模型下次直接用新字段', learned.tokenField, 'max_completion_tokens');

  // 双向：只认旧字段的第三方网关也要能被纠回 max_tokens
  const reverseBody = JSON.stringify({ error: { message: "Unsupported parameter: 'max_completion_tokens'. Please use 'max_tokens'.", param: 'max_completion_tokens' } });
  const reverseKey = M.modelParamKey('custom', 'gpt-9-legacy', 'https://third-party.example/v1');
  const back = M.adaptPayloadToError({ model: 'x', max_completion_tokens: 900 }, 400, reverseBody, reverseKey);
  eq('双向纠偏：只认旧字段的网关被纠回 max_tokens', back?.max_tokens, 900);
  eq('双向纠偏：不留 max_completion_tokens', Object.prototype.hasOwnProperty.call(back || {}, 'max_completion_tokens'), false);

  // temperature：推理模型只接受默认值
  const tempBody = JSON.stringify({ error: { message: "Unsupported value: 'temperature' does not support 0.1 with this model. Only the default (1) value is supported.", param: 'temperature' } });
  const tempKey = M.modelParamKey('openai', 'gpt-6-astra', 'https://api.openai.com/v1');
  const noTemp = M.adaptPayloadToError({ model: 'gpt-6-astra', temperature: 0.1, max_completion_tokens: 300 }, 400, tempBody, tempKey);
  eq('纠偏：剔除 temperature', Object.prototype.hasOwnProperty.call(noTemp || {}, 'temperature'), false);
  eq('纠偏：输出长度字段未受影响', noTemp?.max_completion_tokens, 300);
  eq('会话记忆：temperature 不再发送', M.resolveModelParamPlan('openai', 'gpt-6-astra', 'https://api.openai.com/v1').supportsTemperature, false);

  // 不误改：取值范围类报错、鉴权、5xx 都不该触发参数改写
  const rangeBody = JSON.stringify({ error: { message: "Invalid 'max_tokens': integer below minimum value. Expected a value >= 1.", param: 'max_tokens' } });
  eq('不误改：取值范围报错不作参数改写', M.adaptPayloadToError({ max_tokens: 0 }, 400, rangeBody, key), null);
  eq('不误改：401 不处理', M.adaptPayloadToError({ max_tokens: 100 }, 401, ISSUE_BODY, key), null);
  eq('不误改：500 不处理', M.adaptPayloadToError({ max_tokens: 100 }, 500, ISSUE_BODY, key), null);
  eq('不误改：无关 400 不处理', M.adaptPayloadToError({ max_tokens: 100 }, 400, '{"error":{"message":"messages is required"}}', key), null);
}

// ---- 端到端：桩掉主进程代理，断言真实请求体 ----
const CONFIG = (over = {}) => ({
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-5.6-luna',
  temperature: 0.1,
  ...over,
});

/** 安装假代理：按顺序返回预置响应；返回 calls（每次请求的 payload 快照）。 */
function installProxy(responses) {
  const calls = [];
  globalThis.__llmProxy = async (_url, payload) => {
    calls.push(JSON.parse(JSON.stringify(payload)));
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: JSON.stringify(r.body) };
  };
  return calls;
}
const OK_TEXT = { status: 200, body: { choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }], usage: {} } };
const ERR_TEMP = {
  status: 400,
  body: { error: { message: "Unsupported value: 'temperature' does not support 0.1 with this model. Only the default (1) value is supported.", param: 'temperature' } },
};
const ERR_TOKENS = {
  status: 400,
  body: { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", param: 'max_tokens', code: 'unsupported_parameter' } },
};

// ===== D-1. 已知模型：首包就用新字段；temperature 被拒后自动剔除并重发 =====
{
  M.resetModelParamAdaptations();
  const calls = installProxy([ERR_TEMP, OK_TEXT]);
  const text = await M.callModel([{ role: 'user', content: 'ping' }], CONFIG({ model: 'gpt-5.6-luna' }), { jsonMode: false, maxTokens: 128, temperature: 0 });
  eq('D1：测试连接成功返回', text, 'pong');
  eq('D1：只发两次（1 次纠偏）', calls.length, 2);
  eq('D1：首包已用 max_completion_tokens', calls[0].max_completion_tokens, 256);
  eq('D1：首包不带 max_tokens', Object.prototype.hasOwnProperty.call(calls[0], 'max_tokens'), false);
  eq('D1：首包带 temperature', calls[0].temperature, 0);
  eq('D1：重发包已剔除 temperature', Object.prototype.hasOwnProperty.call(calls[1], 'temperature'), false);
  eq('D1：重发包仍是 max_completion_tokens', calls[1].max_completion_tokens, 256);

  // 会话记忆：同一模型再测一次，直接一次成功
  const again = installProxy([OK_TEXT]);
  await M.callModel([{ role: 'user', content: 'ping' }], CONFIG({ model: 'gpt-5.6-luna' }), { jsonMode: false, maxTokens: 128, temperature: 0 });
  eq('D1：记忆生效后只发一次', again.length, 1);
  eq('D1：记忆生效后不带 temperature', Object.prototype.hasOwnProperty.call(again[0], 'temperature'), false);
}

// ===== D-2. 静态表判不出的模型：按 issue 原文报错自动改写 =====
{
  M.resetModelParamAdaptations();
  const calls = installProxy([ERR_TOKENS, OK_TEXT]);
  const text = await M.callModel([{ role: 'user', content: 'ping' }], CONFIG({ provider: 'custom', model: 'gpt-9-preview' }), { jsonMode: false, maxTokens: 128, temperature: 0.1 });
  eq('D2：纠偏后成功返回', text, 'pong');
  eq('D2：首包用 max_tokens（未验证的模型不猜）', calls[0].max_tokens, 256);
  eq('D2：重发包改为 max_completion_tokens', calls[1].max_completion_tokens, 256);
  eq('D2：重发包不留 max_tokens', Object.prototype.hasOwnProperty.call(calls[1], 'max_tokens'), false);
  eq('D2：重发包保留 temperature', calls[1].temperature, 0.1);
}

// ===== D-3. 仍在失败的路径：报错要原样抛给用户（不吞、不无限重试） =====
{
  M.resetModelParamAdaptations();
  const calls = installProxy([ERR_TOKENS]);
  let err = null;
  try {
    await M.callModel([{ role: 'user', content: 'ping' }], CONFIG({ provider: 'custom', model: 'gpt-8-alpha' }), { jsonMode: false, maxTokens: 64 });
  } catch (e) { err = e; }
  ok('D3：持续 400 时抛 AIError', Boolean(err && err.code === 'AI_HTTP'), 'err=' + (err && err.code));
  ok('D3：报错含服务端原文（可定位）', /max_completion_tokens|max_tokens/.test(String(err?.message || '')));
  ok('D3：重试次数有界（≤3 次请求）', calls.length <= 3, 'calls=' + calls.length);
}

// ===== D-4. JSON 补齐调用必须沿用同一口径（此前写死 max_tokens → 补齐必然 400） =====
{
  M.resetModelParamAdaptations();
  const calls = installProxy([
    { status: 200, body: { choices: [{ message: { content: '{"score":80,"dimensions":{"skill":90' }, finish_reason: 'stop' }], usage: {} } },
    { status: 200, body: { choices: [{ message: { content: '{"score":80,"reason":"ok"}' }, finish_reason: 'stop' }], usage: {} } },
  ]);
  const out = await M.callModel([{ role: 'user', content: '给我一个 json：{"score":0,"reason":""}' }], CONFIG({ model: 'gpt-5.6-luna' }), { jsonMode: true });
  eq('D4：补齐后拿到完整对象', out?.reason, 'ok');
  eq('D4：共两次请求（原始 + 补齐）', calls.length, 2);
  const repair = calls[1];
  eq('D4：补齐请求用 max_completion_tokens（截断场景抬到 2× 上限）', repair.max_completion_tokens, 5600);
  eq('D4：补齐请求不含 max_tokens', Object.prototype.hasOwnProperty.call(repair, 'max_tokens'), false);
  eq('D4：补齐请求仍要求 json 对象', repair.response_format?.type, 'json_object');
}

try { rmSync(dir, { recursive: true, force: true }); } catch {}

console.log('[LLM 参数口径回归] 通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
  for (const f of fails) console.log('  FAIL  ' + f);
  process.exit(1);
}
