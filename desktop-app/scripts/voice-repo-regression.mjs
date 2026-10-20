// 克隆音色仓储回归：不依赖模型、不依赖 Electron（stub 掉 app.getPath）。
//
// 覆盖的是「录进来的东西能不能安全落盘」这一层：
//   · 时长窗口 3–10s（短了音色不稳、长了没意义）；
//   · 静音/几乎没声音必须拒绝（否则克隆出来是电流声，用户以为是模型坏了）；
//   · 授权声明是硬门槛；
//   · WAV 编解码往返一致（16-bit 量化误差 < 1/32767）；
//   · 路径穿越（id 里的 ../）必须被挡住。
//
// 用法：node scripts/voice-repo-regression.mjs
import Module from 'node:module';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'voice-repo-'));
const origLoad = Module._load;
Module._load = function (req, ...args) {
  if (req === 'electron') {
    return { app: { getPath: () => home, getAppPath: () => home } };
  }
  return origLoad.apply(this, [req, ...args]);
};
process.env.BOSSCLAW_SPEECH_DIR = home;

const require = createRequire(import.meta.url);
const repo = require('../electron/mockInterviewVoiceRepo.cjs');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(`${name}：${e.message}`);
    console.log(`  ✗ ${name}  ${e.message}`);
  }
}
function eq(a, b, label = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${label} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
  }
}
function ok(v, label = '') {
  if (!v) throw new Error(`${label} 期望为真`);
}
function b64(samples) {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64');
}
function sine(sec, rate = 16000, amp = 0.25) {
  const n = Math.round(sec * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.sin((2 * Math.PI * 220 * i) / rate) * amp;
  return out;
}
const REF_TEXT = '大家好，我是今天的面试官。我们先用三分钟聊聊你最近负责的项目。';

console.log('克隆音色仓储回归');

check('WAV 编解码往返（16-bit 量化误差 < 2/32768）', () => {
  const src = sine(0.5);
  const wav = repo.encodeWav(src, 16000);
  const back = repo.decodeWav(wav);
  eq(back.sampleRate, 16000, '采样率');
  eq(back.samples.length, src.length, '采样点数');
  let maxErr = 0;
  for (let i = 0; i < src.length; i += 1) maxErr = Math.max(maxErr, Math.abs(back.samples[i] - src[i]));
  ok(maxErr < 2 / 32768, `往返最大误差 ${maxErr}`);
});

check('拒绝未勾选授权声明', () => {
  const r = repo.create({ samplesBase64: b64(sine(5)), sampleRate: 16000, refText: REF_TEXT, licenseAck: false });
  eq(r.ok, false);
  ok(/授权/.test(r.error), r.error);
});

check('拒绝短于 3 秒的录音', () => {
  const r = repo.create({ samplesBase64: b64(sine(2)), sampleRate: 16000, refText: REF_TEXT, licenseAck: true });
  eq(r.ok, false);
  ok(/至少需要 3 秒/.test(r.error), r.error);
});

check('拒绝超过 10 秒的录音', () => {
  const r = repo.create({ samplesBase64: b64(sine(11)), sampleRate: 16000, refText: REF_TEXT, licenseAck: true });
  eq(r.ok, false);
  ok(/超过 10 秒/.test(r.error), r.error);
});

check('拒绝几乎静音的录音', () => {
  const quiet = new Float32Array(16000 * 5).fill(0);
  const r = repo.create({ samplesBase64: b64(quiet), sampleRate: 16000, refText: REF_TEXT, licenseAck: true });
  eq(r.ok, false);
  ok(/没声音/.test(r.error), r.error);
});

let voiceId = '';
check('4 秒有效录音可创建音色', () => {
  const r = repo.create({
    name: '测试音色',
    samplesBase64: b64(sine(4)),
    sampleRate: 16000,
    refText: REF_TEXT,
    licenseAck: true,
  });
  eq(r.ok, true, r.error || '');
  ok(/^clone_[a-f0-9]{12}$/.test(r.voice.id), `id 形态 ${r.voice.id}`);
  voiceId = r.voice.id;
  ok(existsSync(join(home, 'voices', voiceId, 'ref.wav')), 'ref.wav 应存在');
  ok(existsSync(join(home, 'voices', voiceId, 'manifest.json')), 'manifest.json 应存在');
});

check('列表能读回音色与时长', () => {
  const r = repo.list();
  eq(r.voices.length, 1, '数量');
  eq(r.voices[0].name, '测试音色', '名称');
  ok(Math.abs(r.voices[0].durationSec - 4) < 0.01, `时长 ${r.voices[0].durationSec}`);
});

check('readRef 返回与参考文本一致的音频', () => {
  const ref = repo.readRef(voiceId);
  ok(ref, 'readRef 不应为空');
  eq(ref.sampleRate, 16000, '采样率');
  eq(ref.refText, REF_TEXT, '参考文本');
  ok(Math.abs(ref.samples.length / 16000 - 4) < 0.01, '时长');
});

check('重命名生效且不改变音频', () => {
  const before = repo.readRef(voiceId).samples.length;
  const r = repo.rename(voiceId, '新名字');
  eq(r.ok, true, r.error || '');
  eq(repo.list().voices[0].name, '新名字', '名称');
  eq(repo.readRef(voiceId).samples.length, before, '音频长度');
});

check('路径穿越的 id 被拒绝', () => {
  eq(repo.readRef('clone_../../etc'), null, 'readRef');
  let threw = false;
  try { repo.remove('clone_../../etc'); } catch { threw = true; }
  ok(threw, 'remove 应抛错');
});

check('空名称重命名被拒绝', () => {
  const r = repo.rename(voiceId, '   ');
  eq(r.ok, false);
});

check('删除音色后目录消失', () => {
  const r = repo.remove(voiceId);
  eq(r.ok, true, r.error || '');
  eq(repo.list().voices.length, 0, '数量');
  ok(!existsSync(join(home, 'voices', voiceId)), '目录应删除');
});

check('clearAll 清空全部音色并返回体积', () => {
  for (let i = 0; i < 2; i += 1) {
    repo.create({
      name: `v${i}`,
      samplesBase64: b64(sine(3.5)),
      sampleRate: 16000,
      refText: REF_TEXT,
      licenseAck: true,
    });
  }
  eq(repo.usage().count, 2, '清理前');
  const r = repo.clearAll();
  eq(r.ok, true);
  eq(r.removed, 2, '删除数量');
  eq(repo.usage().count, 0, '清理后');
});

rmSync(home, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n${failures.length} 条失败：`);
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`\n全部通过（${passed} 条）`);
