// 朗读模型切换回归（不依赖真模型，只测目录判定 / 偏好 / 配置分派）
//
// 这块不变量有三条，任何一条破了 UI 都会「看起来切了但声音没变」：
//   1) 两套包可以并存，status 必须同时报出来（否则切换按钮无处可点）；
//   2) 切换只改偏好 settings.ttsPack，不改文件；删掉当前生效的那套要自动回落另一套；
//   3) modelConfig() 必须按生效包分派引擎：Kokoro → kokoro 配置，MeloTTS → vits 且 dataDir 为空
//      （MeloTTS 塞 espeak-ng-data 会直接加载失败，这是 2026-10-31 实测踩过的坑）。
//
// 用法：node scripts/speech-pack-switch-regression.mjs
import Module from 'node:module';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'speech-pack-'));
const origLoad = Module._load;
Module._load = function (req, ...args) {
  if (req === 'electron') {
    return {
      app: {
        getPath: () => home,
        getAppPath: () => home,
        isPackaged: true,
        getName: () => 'BossClaw',
      },
    };
  }
  return origLoad.apply(this, [req, ...args]);
};
process.env.BOSSCLAW_SPEECH_DIR = home;

const require = createRequire(import.meta.url);
const install = require('../electron/speechInstall.cjs');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failures.push(`${name}：${e.message}`); console.log(`  ✗ ${name}  ${e.message}`); }
}
function eq(a, b, label = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
function ok(v, label = '') { if (!v) throw new Error(`${label} 期望为真`); }

function makeKokoro() {
  const dir = join(home, 'models', 'tts');
  mkdirSync(join(dir, 'espeak-ng-data'), { recursive: true });
  for (const f of ['model.onnx', 'voices.bin', 'tokens.txt', 'lexicon-zh.txt']) writeFileSync(join(dir, f), 'x');
  writeFileSync(join(dir, 'espeak-ng-data', 'phontab'), 'x');
  return dir;
}
function makeMelo() {
  const dir = join(home, 'models', 'melo');
  mkdirSync(join(dir, 'dict'), { recursive: true });
  for (const f of ['model.onnx', 'tokens.txt', 'lexicon.txt']) writeFileSync(join(dir, f), 'x');
  return dir;
}
function readSettings() {
  try { return JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')); } catch { return {}; }
}

console.log('朗读模型切换回归');

// ===== 一套都没有 =====
check('两套都没装时 status 报未安装', () => {
  const st = install.status();
  eq(st.tts.installed, false);
  eq(st.tts.pack, '');
  eq(st.tts.packs.kokoro.installed, false);
  eq(st.tts.packs.melo.installed, false);
  eq(install.modelConfig(), null, 'modelConfig');
});

check('没装就切换会被拒', () => {
  const r = install.setTtsPack('melo');
  eq(r.ok, false);
  ok(r.error.includes('尚未安装'), '错误文案要点明没装');
});

// ===== 只装 Kokoro =====
const kokoroDir = makeKokoro();
check('只装 Kokoro：默认生效、配置走 kokoro 分支', () => {
  const st = install.status();
  eq(st.tts.pack, 'kokoro');
  eq(st.tts.engine, 'kokoro');
  ok(st.tts.name.includes('Kokoro'), '名称');
  const cfg = install.modelConfig();
  eq(cfg.engine, 'kokoro');
  ok(cfg.config.dataDir.endsWith('espeak-ng-data'), 'Kokoro 要带 espeak-ng-data');
  ok(cfg.config.voices.endsWith('voices.bin'), 'Kokoro 要带 voices.bin');
  ok(cfg.config.lexicon.endsWith('lexicon-zh.txt'), '词典优先中文');
});

// ===== 再装 MeloTTS =====
const meloDir = makeMelo();
check('两套并存：status 同时报出来，默认仍是 Kokoro', () => {
  const st = install.status();
  eq(st.tts.packs.kokoro.installed, true);
  eq(st.tts.packs.melo.installed, true);
  eq(st.tts.pack, 'kokoro', '没切换前不该变');
  eq(st.tts.packs.melo.dir, meloDir, 'melo 目录');
});

check('切到 MeloTTS：偏好落盘、引擎换成 vits、dataDir 为空', () => {
  const r = install.setTtsPack('melo');
  eq(r.ok, true);
  eq(r.engine, 'vits');
  eq(readSettings().ttsPack, 'melo', 'settings.ttsPack');
  const st = install.status();
  eq(st.tts.pack, 'melo');
  eq(st.tts.engine, 'vits');
  ok(st.tts.name.includes('MeloTTS'), '名称跟着换');
  const cfg = install.modelConfig();
  eq(cfg.engine, 'vits');
  eq(cfg.config.dataDir, '', 'MeloTTS 的 dataDir 必须为空');
  ok(cfg.config.model.endsWith('model.onnx'), '主模型');
  ok(cfg.config.lexicon.endsWith('lexicon.txt'), 'lexicon.txt');
});

check('非法包名 / 空值被拒', () => {
  eq(install.setTtsPack('pocket').ok, false);
  eq(install.setTtsPack('').ok, false);
  eq(readSettings().ttsPack, 'melo', '拒绝时不该改偏好');
});

check('切回 Kokoro 后配置也切回去', () => {
  eq(install.setTtsPack('kokoro').ok, true);
  eq(install.modelConfig().engine, 'kokoro');
  eq(readSettings().ttsPack, 'kokoro');
});

check('Kokoro 目录不会被误判成 MeloTTS（两套判定互斥）', () => {
  eq(install._isComplete(kokoroDir), true);
  eq(install._isCompleteMelo(kokoroDir), false, 'Kokoro 有 voices.bin，不能算 MeloTTS');
  eq(install._isCompleteMelo(meloDir), true);
  eq(install._isComplete(meloDir), false, 'MeloTTS 没有 voices.bin，不能算 Kokoro');
});

// ===== 删除与回落 =====
check('删掉当前生效的包：偏好清空、自动回落另一套', () => {
  install.setTtsPack('melo');
  const r = install.removeTts('melo');
  eq(r.ok, true);
  eq(r.pack, 'melo');
  const st = install.status();
  eq(st.tts.packs.melo.installed, false);
  eq(st.tts.pack, 'kokoro', '应回落到 Kokoro');
  eq(st.tts.engine, 'kokoro');
  eq(install.modelConfig().engine, 'kokoro');
});

check('删掉非生效包：偏好不好被清掉', () => {
  makeMelo();
  install.setTtsPack('melo');
  install.removeTts('kokoro');
  eq(readSettings().ttsPack, 'melo', '删的是一套，不该动另一套的偏好');
  eq(install.status().tts.pack, 'melo');
});

check('两套都删光：status 未安装、modelConfig 为 null', () => {
  install.removeTts('melo');
  const st = install.status();
  eq(st.tts.installed, false);
  eq(st.tts.pack, '');
  eq(install.modelConfig(), null);
});

console.log(`\n${failures.length === 0 ? '全部通过' : `${failures.length} 条失败`}（${passed} 条）`);
if (failures.length) {
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
