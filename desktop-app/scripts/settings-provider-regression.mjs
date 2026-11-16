// 设置页「模型服务商 / 模型名」回归断言（issue #15）
//
// 为什么需要它：issue #15 的现象是「选不了其他模型」。设置页的模型下拉由两段拼起来：
//   ① 服务商预设（PROVIDER_DEFAULTS[provider].baseUrl / model / models）；
//   ② 「切换服务商」时 applyProviderDefaults 把 baseUrl + model 一起换掉。
// 任何一段漂移都会表现为「下拉里没有可选项」或「选了服务商但模型名还是旧的」，且不会
// 被 typecheck / build 发现（类型只保证字段存在，不保证与预设一致）。
//
// 本脚本同时守住：
//   · 每个服务商预设都自带非空端点 + 至少一个可选项，且默认模型一定在可选项里（否则下拉看不见当前值）；
//   · applyProviderDefaults 必须逐字段套用预设（provider / baseUrl / model），不能只改 provider；
//   · 自定义模型名可以保存（用户仍能输入预设外的模型）；
//   · 设置页 UI 仍然「按当前 provider 取模型列表」，防止有人把 options 写死成某一家的名单。
//
// 用法：node scripts/settings-provider-regression.mjs   （EXIT 0 = 全通过，1 = 有失败）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

// zustand persist 在模块加载时会读 localStorage；这里给最小内存实现，避免依赖真实浏览器环境。
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

const dir = mkdtempSync(join(tmpdir(), 'bossclaw-provider-'));
const outfile = join(dir, 'bundle.cjs');
try {
  await build({
    stdin: {
      contents: [
        "export { PROVIDER_DEFAULTS } from './src/lib/bossclaw/providerPresets.ts';",
        "export { useSettingsStore } from './src/store/useSettingsStore.ts';",
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
  const { PROVIDER_DEFAULTS: P, useSettingsStore } = require(outfile);
  const providers = Object.keys(P);
  const presetProviders = ['openai', 'deepseek', 'qwen', 'zhipu', 'siliconflow', 'volces', 'custom'];

  // ===== A. 预设自身完整性 =====
  eq('服务商名单与设置页预期一致（新增 provider 必须同步预设）', providers.slice().sort().join(','), presetProviders.slice().sort().join(','));
  for (const p of presetProviders) {
    const preset = P[p];
    ok(`预设存在：${p}`, Boolean(preset), 'preset is undefined');
    if (!preset) continue;
    ok(`预设有显示名：${p}`, Boolean(String(preset.label || '').trim()));
    ok(`预设模型列表是数组：${p}`, Array.isArray(preset.models));
    if (p === 'custom') {
      eq(`自定义不预置端点：${p}`, preset.baseUrl, '');
      eq(`自定义不预置模型：${p}`, preset.model, '');
      eq(`自定义不预置模型列表：${p}`, preset.models.length, 0);
      continue;
    }
    ok(`预设端点非空：${p}`, /^https?:\/\//.test(String(preset.baseUrl || '')), 'baseUrl=' + preset.baseUrl);
    ok(`预设默认模型非空：${p}`, Boolean(String(preset.model || '').trim()));
    ok(`默认模型出现在可选项里：${p}`, preset.models.includes(preset.model),
      `model=${preset.model} models=${JSON.stringify(preset.models)}`);
    eq(`模型可选项无重复：${p}`, new Set(preset.models).size, preset.models.length);
  }

  // ===== B. applyProviderDefaults 逐字段套用（issue #15 的核心） =====
  const storeApi = useSettingsStore;
  storeApi.getState().setModel({ apiKey: 'sk-keep-me' });
  for (const p of presetProviders) {
    storeApi.getState().applyProviderDefaults(p);
    const model = storeApi.getState().config.model;
    eq(`切换后 provider 正确：${p}`, model.provider, p);
    eq(`切换后 baseUrl 套用预设：${p}`, model.baseUrl, P[p].baseUrl);
    eq(`切换后 model 套用预设：${p}`, model.model, P[p].model);
    eq(`切换服务商不清空 API Key：${p}`, model.apiKey, 'sk-keep-me');
  }

  // ===== C. 连续切换（openai → qwen → custom → deepseek）不残留上一家 =====
  for (const p of ['openai', 'qwen', 'custom', 'deepseek']) {
    storeApi.getState().applyProviderDefaults(p);
  }
  {
    const model = storeApi.getState().config.model;
    eq('连续切换后回到 deepseek 预设端点', model.baseUrl, P.deepseek.baseUrl);
    eq('连续切换后回到 deepseek 预设模型', model.model, P.deepseek.model);
    ok('连续切换后模型名不残留上一家', !String(model.model).includes('qwen'), 'model=' + model.model);
  }

  // ===== D. 自定义模型名可保存（不是只能选预设） =====
  {
    storeApi.getState().setModel({ provider: 'custom', baseUrl: 'https://gateway.example.com/v1', model: 'my-private-model-2026' });
    const model = storeApi.getState().config.model;
    eq('自定义模型名可保存', model.model, 'my-private-model-2026');
    eq('自定义 Base URL 可保存', model.baseUrl, 'https://gateway.example.com/v1');
    ok('配置完整性判定不因自定义模型名失败', storeApi.getState().isLLMConfigured() === true);
  }

  // ===== E. 设置页 UI 仍按「当前 provider」刷新模型列表（静态守卫） =====
  {
    const settings = readFileSync(join(root, 'src/pages/Settings.tsx'), 'utf8');
    ok('服务商下拉切换时调用 applyProviderDefaults', /onChange=\{\(p\)\s*=>\s*\{[\s\S]*?applyProviderDefaults\(p\)/.test(settings));
    ok('模型下拉的 options 取自当前 provider 的预设',
      /PROVIDER_DEFAULTS\[config\.model\.provider\s+as\s+LLMProvider\]\?\.models/.test(settings));
    ok('模型下拉允许自由输入（AutoComplete）', /<AutoComplete[\s\S]{0,400}?config\.model\.model/.test(settings));
  }

  // ===== F. issue #15 的弹层成因仍由全局对齐守卫兜底（issue #13 的修复不得被摘掉） =====
  {
    const main = readFileSync(join(root, 'src/main.tsx'), 'utf8');
    const guard = readFileSync(join(root, 'src/lib/antdPopupAlignGuard.ts'), 'utf8');
    ok('应用入口仍安装 antd 弹层对齐守卫', /installAntdPopupAlignGuard\(\)/.test(main));
    ok('守卫覆盖 antd Select/AutoComplete 弹层', /\.ant-select-dropdown/.test(guard));
    ok('守卫仍会补发 resize 触发 rc-trigger 重新对齐', /dispatchEvent\(new Event\('resize'\)\)/.test(guard));
  }
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

if (fails.length) {
  console.error(`settings-provider regression: ${pass} passed, ${fails.length} failed`);
  for (const fail of fails) console.error('FAIL ' + fail);
  process.exitCode = 1;
} else {
  console.log(`settings-provider regression: ${pass}/${pass} passed`);
}
