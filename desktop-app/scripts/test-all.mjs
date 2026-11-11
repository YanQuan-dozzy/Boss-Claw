// test-all.mjs —— 一键跑全部「可离线、无外部运行时」回归
//
// 背景（2026-10-21 分模块审查 B-5）：
//   仓库里 40+ 个回归脚本各自独立可跑，但 19 个从未出现在 package.json 里，等于没有入口；
//   另有 4 个依赖 Electron / Playwright / 语音模型，混在一起就变成「跑一次红一片」，
//   于是没人再跑 —— 门槛缺失的真正后果不是缺命令，而是**没人执行**。
//
// 本脚本的分工：
//   · SUITES  = 纯逻辑 / DOM 仿真 / 文本解析类，秒级完成，可在 CI 无条件跑；
//   · SKIP    = 需要真实 Electron、Playwright Chromium 或语音模型的用例，写清原因后排除；
//   · GUARD   = 新增 `*-regression.mjs` / `*-smoke.mjs` 却既没进 SUITES 也没进 SKIP → 直接失败。
//               （「清单型不变量」靠人眼必然漂移，这是审查里反复出现的教训。）
//
// 用法：node scripts/test-all.mjs [--only mock-interview] [--list]

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptsDir = join(root, 'scripts');

/** 纯逻辑回归（顺序即执行顺序：先静态守卫，再领域逻辑，最后 IO/解析） */
const SUITES = [
  'ipc-channel-parity.mjs',
  // 共用文件（README.md / .gitignore）不得出现私有仓库口径 —— 串味不报错，只能靠断言
  'repo-hygiene.mjs',
  'theme-vars-regression.mjs',
  'css-guard-regression.mjs',
  'jsx-key-regression.mjs',
  // issue #13：antd Select 弹层偶发停在 -1000vw/-1000vh（检测 + 补发 resize）不得误伤正常弹层
  'select-popup-align-regression.mjs',
  'context-budget-regression.mjs',
  // issue #10：写失败必须可见（配额耗尽时数据静默不落盘 → 重启后进度回退）
  'persist-health-regression.mjs',
  // issue #10 根治：队列迁到主进程文件（原子写 / .bak 回退 / 防抖单飞 / 迁移验真）
  'queue-store-regression.mjs',
  'activity-window-regression.mjs',
  'cooldown-regression.mjs',
  'delivery-throttle-regression.mjs',
  'score-regression.mjs',
  'mock-interview-score-regression.mjs',
  'mock-interview-delivery-regression.mjs',
  'bank-recall-regression.mjs',
  'bank-repo-smoke.mjs',
  'llm-json-regression.mjs',
  // 版本更新检查：版本比较用字符串会静默判错（2.10.0 < 2.9.0），必须断言
  'update-check-regression.mjs',
  'material-path-regression.mjs',
  'greeting-regression.mjs',
  'humanize-regression.mjs',
  'tailor-job-regression.mjs',
  'tailor-batch-regression.mjs',
  'liepin-im-regression.mjs',
  'liepin-apply-regression.mjs',
  'liepin-jd-regression.mjs',
  'liepin-url-regression.mjs',
  'zhaopin-jd-regression.mjs',
  'zhaopin-url-regression.mjs',
  'doc-parse-regression.mjs',
  'pdf-parse-regression.mjs',
  'edge-tts-protocol-regression.mjs',
  'edge-tts-service-regression.mjs',
  'voice-repo-regression.mjs',
  'speech-pack-switch-regression.mjs',
  'voice-pack-regression.mjs',
  'tts-stream-regression.mjs',
  'tts-pcm-regression.mjs',
];

/** 需外部运行时的用例：file → 原因（改这里之前先确认环境真的具备） */
const SKIP = new Map([
  ['tailor-iteration-regression.mjs', '需真实 Electron 窗口 + offscreen 截图（无显示环境会「等待超时」）'],
  ['webview-send-regression.mjs', '需 Playwright Chromium 二进制（npx playwright install chromium）'],
  ['webview-native-send-regression.mjs', '需真实 Electron <webview> 运行时（node node_modules/electron/install.js）'],
  ['mock-interview-tts-smoke.mjs', '需本地语音模型（sherpa-onnx）与音频输出'],
  ['mock-interview-tts-service-smoke.mjs', '需本地语音模型（sherpa-onnx）'],
  ['mock-interview-tts-stream-smoke.mjs', '需本地语音模型（流式合成）'],
  ['mock-interview-voice-vits-smoke.mjs', '需 VITS 音色模型'],
  ['mock-interview-voice-melo-smoke.mjs', '需 MeloTTS 音色模型'],
  ['mock-interview-clone-smoke.mjs', '需 ZipVoice 克隆模型'],
  ['mock-interview-asr-smoke.mjs', '需 ASR 模型（model.int8.onnx）'],
]);

const argv = process.argv.slice(2);
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx >= 0 ? String(argv[onlyIdx + 1] || '') : '';
if (argv.includes('--list')) {
  for (const f of SUITES) console.log('  ' + f);
  console.log(`\n跳过 ${SKIP.size} 个（需外部运行时）：`);
  for (const [f, why] of SKIP) console.log(`  - ${f}：${why}`);
  process.exit(0);
}

// ===== 守卫：脚本目录里的回归/冒烟用例必须登记 =====
// 注意：`onDisk` 只取 *-regression / *-smoke 用于「孤儿检查」；「已不存在」必须与**全部**
// 脚本文件比对 —— 否则 guard 类脚本（ipc-channel-parity / repo-hygiene 等不遵命名约定的）
// 每次都会被误报成「文件已不存在」。
const onDiskAll = readdirSync(scriptsDir);
const onDisk = onDiskAll.filter((f) => /-(regression|smoke)\.mjs$/.test(f));
const registered = new Set([...SUITES, ...SKIP.keys()]);
const orphans = onDisk.filter((f) => !registered.has(f)).sort();
if (orphans.length) {
  console.error(`\n❌ 有 ${orphans.length} 个回归脚本未登记（既不在 SUITES 也不在 SKIP）：`);
  for (const f of orphans) console.error('  - ' + f);
  console.error('\n请把它加进本文件：能离线跑 → SUITES；需要外部运行时 → SKIP 并写明原因。');
  process.exit(1);
}
const missing = [...registered].filter((f) => !onDiskAll.includes(f));
if (missing.length) {
  console.warn(`\n⚠️ 登记表里有 ${missing.length} 个文件已不存在，请清理：${missing.join(', ')}`);
}

const list = only ? SUITES.filter((f) => f.includes(only)) : SUITES;
if (!list.length) {
  console.error(`❌ --only ${only} 没有匹配任何用例`);
  process.exit(1);
}

const TIMEOUT_MS = 180_000;
const results = [];
const started = Date.now();

for (const [i, file] of list.entries()) {
  const label = `[${i + 1}/${list.length}] ${file}`;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [join(scriptsDir, file)], {
    cwd: root,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    windowsHide: true,
  });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  results.push({ file, ok, ms, status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` });
  if (ok) {
    process.stdout.write(`  ✓ ${label}  ${(ms / 1000).toFixed(1)}s\n`);
  } else {
    process.stdout.write(`  ✗ ${label}  ${(ms / 1000).toFixed(1)}s  (exit ${r.status}${r.signal ? '/' + r.signal : ''})\n`);
  }
}

const failed = results.filter((x) => !x.ok);
console.log(`\n[全部回归] ${results.length - failed.length}/${results.length} 通过，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (failed.length) {
  for (const f of failed) {
    const tail = f.out.trim().split('\n').slice(-12).join('\n');
    console.error(`\n--- 失败：${f.file} (exit ${f.status}) ---\n${tail}`);
  }
  console.error(`\n共 ${failed.length} 个套件失败。单跑排查：node scripts/<file>`);
  process.exit(1);
}
console.log(`已跳过 ${SKIP.size} 个需外部运行时的用例（--list 查看原因）。`);
