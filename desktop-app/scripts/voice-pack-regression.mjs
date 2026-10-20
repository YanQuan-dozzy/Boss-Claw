// 音色包探测/导入回归（不依赖模型，只测目录判定与落盘）
//
// 判定三档是这块的核心：ok / unsupported（能说清是哪一族）/ unknown（判不出）。
// 这三档如果混在一起，用户会看到「你这个包坏了」而不是「本版不支持 Matcha」——
// 前者会让人反复重下，后者才是可行动的结论。
//
// 用法：node scripts/voice-pack-regression.mjs
import Module from 'node:module';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'voice-pack-'));
const origLoad = Module._load;
Module._load = function (req, ...args) {
  if (req === 'electron') return { app: { getPath: () => home, getAppPath: () => home } };
  return origLoad.apply(this, [req, ...args]);
};
process.env.BOSSCLAW_SPEECH_DIR = home;

const require = createRequire(import.meta.url);
const pack = require('../electron/mockInterviewVoicePack.cjs');
const repo = require('../electron/mockInterviewVoiceRepo.cjs');

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
function has(text, sub) { if (!String(text).includes(sub)) throw new Error(`「${text}」不含「${sub}」`); }

const tmp = join(home, 'packs');
mkdirSync(tmp, { recursive: true });

function makePack(name, files) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    if (f.endsWith('/')) mkdirSync(join(dir, f), { recursive: true });
    else writeFileSync(join(dir, f), f.endsWith('.json') ? '{"num_speakers": 4}' : 'x');
  }
  return dir;
}

console.log('音色包探测/导入回归');

const kokoro = makePack('kokoro-ok', ['model.onnx', 'voices.bin', 'tokens.txt', 'espeak-ng-data/']);
const kokoroBad = makePack('kokoro-missing', ['model.onnx', 'voices.bin']);
const vits = makePack('vits-ok', ['zh_CN-huayan.onnx', 'zh_CN-huayan.onnx.json', 'tokens.txt', 'espeak-ng-data/']);
const zv = makePack('zipvoice-ok', ['encoder.int8.onnx', 'decoder.int8.onnx', 'vocos_24khz.onnx', 'tokens.txt']);
const zvBad = makePack('zipvoice-no-vocoder', ['encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt']);
const matcha = makePack('matcha', ['model.onnx', 'vocoder.onnx', 'tokens.txt']);
const pocket = makePack('pocket', ['lm_main.onnx', 'lm_flow.onnx', 'encoder.onnx', 'decoder.onnx', 'vocab.json']);
const bare = makePack('bare', ['model.onnx']);

check('Kokoro 布局判定可用', () => {
  const p = pack.probe(kokoro);
  eq(p.ok, true, p.error || '');
  eq(p.engine, 'kokoro');
  eq(p.family, 'kokoro');
  ok(p.fileCount >= 3, '文件数');
});

check('Kokoro 缺 tokens 时点名缺什么', () => {
  const p = pack.probe(kokoroBad);
  eq(p.ok, false);
  has(p.reason, 'tokens.txt');
});

check('VITS 布局判定可用且读出说话人数', () => {
  const p = pack.probe(vits);
  eq(p.ok, true, p.error || '');
  eq(p.engine, 'vits');
  eq(p.numSpeakers, 4, 'num_speakers');
});

// 实测（2026-10-19）：原生 Piper 包直接加载会报
// "'sample_rate' does not exist in the metadata" —— 光补 tokens.txt 并不能救活它，
// 所以这里必须与「缺 tokens 的普通包」分开成档，并给出「去拿转换版」的指引。
const piperRaw = makePack('piper-raw', ['zh_CN-huayan.onnx', 'zh_CN-huayan.onnx.json']);
const vitsNoEspeak = makePack('vits-no-espeak', ['zh_CN-huayan.onnx', 'zh_CN-huayan.onnx.json', 'tokens.txt']);

check('原生 Piper 包单独成档，并指路「转换版」', () => {
  const p = pack.probe(piperRaw);
  eq(p.ok, false);
  eq(p.engine, 'vits', '引擎族仍是 vits');
  eq(p.kind, 'piper-raw');
  has(p.reason, 'Piper 原生包');
  has(p.reason, '转换版');
  ok(!p.reason.includes('部分可省'), '不应再暗示「补个 tokens 就能用」');
});

check('转换版 vits 包（无 espeak-ng-data）标出要借音素数据', () => {
  const p = pack.probe(vitsNoEspeak);
  eq(p.ok, true, p.error || '');
  eq(p.kind, 'vits');
  eq(p.needsEspeak, true);
  eq(pack.needsEspeakData(vitsNoEspeak, 'vits'), true);
  eq(pack.needsEspeakData(vits, 'vits'), false, '自带 espeak-ng-data 时不需要借');
});

check('vits 缺音素数据时回落到调用方给的内置包', () => {
  const cfg = pack.buildEngineConfig(vitsNoEspeak, 'vits', { fallbackDataDir: '/fake/espeak-ng-data' });
  eq(cfg.dataDir, '/fake/espeak-ng-data');
  const none = pack.buildEngineConfig(vitsNoEspeak, 'vits');
  eq(none.dataDir, '', '没有回落时留空，由调用方给出可读错误');
  const own = pack.buildEngineConfig(vits, 'vits', { fallbackDataDir: '/fake/espeak-ng-data' });
  ok(own.dataDir.endsWith('espeak-ng-data') && !own.dataDir.startsWith('/fake'), '包内自带的优先');
});

check('ZipVoice 布局判定可用', () => {
  const p = pack.probe(zv);
  eq(p.ok, true, p.error || '');
  eq(p.engine, 'zipvoice');
});

check('ZipVoice 缺声码器时点名', () => {
  const p = pack.probe(zvBad);
  eq(p.ok, false);
  has(p.reason, '声码器');
});

check('Matcha 布局明确说不支持（而不是判不出）', () => {
  const p = pack.probe(matcha);
  eq(p.ok, false);
  eq(p.family, 'matcha');
  has(p.reason, '暂不支持导入');
});

check('Pocket 布局明确说不支持', () => {
  const p = pack.probe(pocket);
  eq(p.ok, false);
  eq(p.family, 'pocket');
  has(p.reason, '暂不支持导入');
});

check('裸 onnx 判不出（unknown）且给出需要什么', () => {
  const p = pack.probe(bare);
  eq(p.ok, false);
  eq(p.family, 'unknown');
  has(p.reason, '判不出');
});

check('选择文件而不是目录时报错', () => {
  const p = pack.probe(join(kokoro, 'tokens.txt'));
  eq(p.ok, false);
  has(p.error, '目录');
});

check('超过 600MB 上限被拦（不进入复制）', () => {
  const big = makePack('huge', ['model.onnx', 'tokens.txt', 'voices.bin']);
  truncateSync(join(big, 'model.onnx'), 601 * 1024 * 1024);
  const p = pack.probe(big);
  eq(p.ok, false);
  has(p.error, '上限');
});

check('多词典时优先中文词典（否则中文会全被 OOV 丢掉）', () => {
  const dir = makePack('kokoro-lexicon', [
    'model.onnx',
    'voices.bin',
    'tokens.txt',
    'lexicon-gb-en.txt',
    'lexicon-us-en.txt',
    'lexicon-zh.txt',
    'espeak-ng-data/',
  ]);
  const cfg = pack.buildEngineConfig(dir, 'kokoro');
  ok(cfg.lexicon.endsWith('lexicon-zh.txt'), `实际选了 ${cfg.lexicon}`);
});

check('导入 Kokoro 包：复制 + manifest + 列表可见', () => {
  const r = repo.importFromDir(kokoro, { name: '测试导入', license: 'CC-BY-4.0' });
  eq(r.ok, true, r.error || '');
  ok(/^voice_[a-f0-9]{12}$/.test(r.voice.id), `id ${r.voice.id}`);
  ok(existsSync(join(home, 'voices', r.voice.id, 'tokens.txt')), '模型文件应复制');
  ok(existsSync(join(home, 'voices', r.voice.id, 'manifest.json')), 'manifest 应存在');
  const list = repo.list().voices.filter((v) => v.kind === 'imported');
  eq(list.length, 1, '导入数量');
  eq(list[0].engine, 'kokoro');
  eq(list[0].license, 'CC-BY-4.0');
});

check('导入后 engineConfig 指向复制目录（不是原目录）', () => {
  const v = repo.list().voices.find((x) => x.kind === 'imported');
  const cfg = repo.engineConfig(v.id);
  ok(cfg, 'engineConfig');
  eq(cfg.engine, 'kokoro');
  ok(cfg.config.model.includes(join('voices', v.id)), `路径 ${cfg.config.model}`);
  ok(!cfg.config.model.includes('packs'), '不应指向源目录');
});

check('删掉源目录后，复制出来的音色仍可用', () => {
  const v = repo.list().voices.find((x) => x.kind === 'imported');
  const cfg = repo.engineConfig(v.id);
  ok(cfg && existsSync(cfg.config.model), '复制目录里的模型存在');
  // 真删源目录：音色用的是复制件，不能因为用户清空下载目录就失效
  rmSync(kokoro, { recursive: true, force: true });
  ok(!existsSync(kokoro), '源目录已删');
  const after = repo.engineConfig(v.id);
  ok(after && existsSync(after.config.model), '删源后复制件仍可用');
});

check('删除导入音色后目录消失、engineConfig 返回 null', () => {
  const v = repo.list().voices.find((x) => x.kind === 'imported');
  const r = repo.remove(v.id);
  eq(r.ok, true, r.error || '');
  eq(repo.engineConfig(v.id), null);
  ok(!existsSync(join(home, 'voices', v.id)), '目录应删除');
});

check('导入不支持布局时直接拒绝且不落盘', () => {
  const before = repo.list().voices.length;
  const r = repo.importFromDir(matcha, { name: 'x' });
  eq(r.ok, false);
  has(r.error, '暂不支持');
  eq(repo.list().voices.length, before, '数量不变');
});

rmSync(home, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n${failures.length} 条失败：`);
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`\n全部通过（${passed} 条）`);
