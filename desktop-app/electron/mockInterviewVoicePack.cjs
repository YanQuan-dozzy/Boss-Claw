// electron/mockInterviewVoicePack.cjs —— 导入音色包的探测、校验与运行时配置（P2 剩余）
//
// 只做纯逻辑（读目录、判模型族、拼配置），不负责复制与落盘——那部分在 voiceRepo。
// 探测按文件特征，不要求用户理解架构（方案 6.5.2）：
//   kokoro   voices.bin + model*.onnx + tokens.txt（还可能要 espeak-ng-data）
//   vits     X.onnx + 同名 X.onnx.json（Piper 系；多说话人看 json 的 num_speakers）
//   zipvoice encoder*.onnx + decoder*.onnx + vocoder/vocos*.onnx
//   matcha   有 model + vocoder + tokens 但没有 .ongx.json → 明确「本版不支持导入」
//   pocket   lm_main/lm_flow → 同上
//   其他     判不出（只有一个裸 onnx / 缺 tokens）
//
// 判定结果分三档：ok / unsupported（能说清是哪一族） / unknown（判不出）。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 单包体积上限：社区中文音色包多在 60–120MB，但 Kokoro 布局的多语言包本体就有 407MB
 * （326MB fp32 模型 + 54MB voices）。上限按 600MB 设，既能收下这类包，又能挡住误选整个模型仓库。
 */
const MAX_PACK_BYTES = 600 * 1024 * 1024;
const MAX_FILES = 4000;

const FAMILY_LABEL = {
  kokoro: 'Kokoro',
  vits: 'Piper / VITS / MeloTTS',
  zipvoice: 'ZipVoice（零样本克隆）',
  matcha: 'Matcha',
  kitten: 'Kitten',
  pocket: 'Pocket',
  unknown: '未识别',
};

function listFiles(dir, limit = MAX_FILES) {
  const out = [];
  let truncated = false;
  const walk = (d, rel) => {
    if (out.length >= limit) { truncated = true; return; }
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) { truncated = true; return; }
      const full = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push({ rel: r, name: e.name, size: 0, dir: true });
        // espeak-ng-data 有大量小文件，只下探两层足够判定存在性
        if (rel.split('/').length < 2) walk(full, r);
      } else {
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* ignore */ }
        out.push({ rel: r, name: e.name, size, dir: false });
      }
    }
  };
  walk(dir, '');
  return { files: out, truncated };
}

const baseName = (f) => f.rel.split('/').pop();
const atRoot = (f) => !f.dir && !f.rel.includes('/');
const has = (files, re) => files.some((f) => atRoot(f) && re.test(f.name));
const find = (files, re) => files.find((f) => atRoot(f) && re.test(f.name)) || null;

/**
 * 词典优先中文：Kokoro 包同时带 lexicon-gb-en / us-en / zh，按字母序会先拿到英文词典，
 * 中文题干会被英文音素表判成 OOV 直接丢掉（实测合成只剩 0.25 秒）。
 * install.cjs 里对内置包已经踩过同一个坑，这里必须同口径。
 */
function findLexicon(files) {
  const all = files.filter((f) => atRoot(f) && /^lexicon.*\.txt$/i.test(f.name));
  return all.find((f) => /zh/i.test(f.name)) || all[0] || null;
}

/**
 * MeloTTS 布局：根目录有**恰好叫 model.onnx** 的主模型 + tokens.txt + lexicon*.txt，
 * 但没有 voices.bin / 声码器 / 同名 .onnx.json。
 *
 * 为什么要单独判（2026-10-31 实测）：
 *   ① 它没有 `.onnx.json`，按 Piper 规则会落进「原生 Piper 包，需转换」被错拒；
 *   ② 它**不需要 espeak-ng-data**（音素走 lexicon + 自带分词表）。而 buildEngineConfig 原本会把
 *      包里的 `dict/`（jieba 词表）当音素目录传下去，sherpa 直接报
 *      `dict/phontab does not exist. Please check --vits-data-dir` 加载失败。
 * 主模型必须精确叫 `model.onnx`：Matcha 的叫 `model-steps-<N>.onnx`，且带声码器，两条都能区分。
 */
function isMeloLayout(files) {
  if (has(files, /^voices\.bin$/i)) return false;
  if (files.some((f) => atRoot(f) && /\.onnx\.json$/i.test(f.name))) return false;
  if (has(files, /^(vocoder|vocos).*\.onnx$/i)) return false;
  return has(files, /^model\.onnx$/i) && has(files, /^tokens\.txt$/i) && has(files, /^lexicon.*\.txt$/i);
}

/**
 * 判模型族。
 * @returns {{family:string, engine:string|null, supported:boolean, reason:string, required:string[], missing:string[]}}
 */
function detect(files) {
  const hasKokoro = has(files, /^voices\.bin$/i) && has(files, /^model.*\.onnx$/i);
  const hasEncDec = has(files, /^encoder.*\.onnx$/i) && has(files, /^decoder.*\.onnx$/i);
  const hasVocoder = has(files, /^(vocoder|vocos).*\.onnx$/i);
  const hasTokens = has(files, /^tokens\.txt$/i);
  const hasJson = files.some((f) => atRoot(f) && /\.onnx\.json$/i.test(f.name));
  const hasLm = has(files, /^lm_(main|flow).*\.onnx$/i);
  const hasEspeak = files.some((f) => f.dir && /^espeak-ng-data$/i.test(baseName(f)));
  const hasLexicon = has(files, /^lexicon.*\.txt$/i);
  const kittenHint = files.some((f) => /kitten/i.test(f.rel));

  if (hasLm) {
    return {
      family: 'pocket',
      engine: null,
      supported: false,
      reason: '这是 Pocket 布局（lm_main / lm_flow）。本版暂不支持导入该模型族，内置 8 个音色与克隆不受影响。',
      required: [],
      missing: [],
    };
  }
  if (kittenHint) {
    return {
      family: 'kitten',
      engine: null,
      supported: false,
      reason: '目录里带 kitten 特征。本版暂不支持导入该模型族（其布局与 Kokoro 接近但音素表不同，硬加载会念错）。',
      required: [],
      missing: [],
    };
  }
  if (hasEncDec) {
    const missing = [];
    if (!hasVocoder) missing.push('vocos_24khz.onnx（声码器）');
    if (!hasTokens) missing.push('tokens.txt');
    return {
      family: 'zipvoice',
      engine: 'zipvoice',
      supported: missing.length === 0,
      reason: missing.length ? `这是 ZipVoice 布局，但缺少：${missing.join('、')}` : '',
      required: ['encoder*.onnx', 'decoder*.onnx', 'vocos*.onnx', 'tokens.txt'],
      missing,
    };
  }
  if (hasKokoro) {
    const missing = [];
    if (!hasTokens) missing.push('tokens.txt');
    if (!hasEspeak && !hasLexicon) missing.push('espeak-ng-data/ 或 lexicon*.txt');
    return {
      family: 'kokoro',
      engine: 'kokoro',
      supported: missing.length === 0,
      reason: missing.length ? `这是 Kokoro 布局，但缺少：${missing.join('、')}` : '',
      required: ['model*.onnx', 'voices.bin', 'tokens.txt'],
      missing,
    };
  }
  // vits：任一根目录 onnx 有同名 .onnx.json
  const vitsModel = files.find(
    (f) => atRoot(f) && /\.onnx$/i.test(f.name) && files.some((x) => x.name === `${f.name}.json`),
  );
  if (vitsModel) {
    if (!hasTokens) {
      // 原生 Piper 包只有 .onnx + .onnx.json。两个硬门槛都过不去：
      //   ① 没有 tokens.txt（音素表，sherpa 的音素→id 映射）；
      //   ② onnx 里没有 sample_rate / has_espeak 等元数据，加载即报
      //      "'sample_rate' does not exist in the metadata"。
      // 所以这不是「补个文件就能用」，必须换成转换版——文案要说清，别让用户去补 tokens。
      return {
        family: 'vits',
        engine: 'vits',
        kind: 'piper-raw',
        supported: false,
        reason: '这是 Piper 原生包。sherpa-onnx 只能加载转换版：它缺 tokens.txt，而且 onnx 里没有采样率等元数据，'
          + '直接加载会失败。请换用已转换的包（目录里会同时有 tokens.txt 与 espeak-ng-data/，'
          + '例如 HuggingFace 上 csukuangfj/vits-piper-<语言>-<音色> 这类仓库）。',
        required: ['*.onnx', '同名 *.onnx.json', 'tokens.txt'],
        missing: ['tokens.txt（转换版才有）'],
      };
    }
    return {
      family: 'vits',
      engine: 'vits',
      kind: 'vits',
      supported: true,
      reason: '',
      required: ['*.onnx', '同名 *.onnx.json', 'tokens.txt'],
      missing: [],
    };
  }
  if (isMeloLayout(files)) {
    return {
      family: 'vits',
      engine: 'vits',
      kind: 'melo',
      supported: true,
      reason: '',
      required: ['model.onnx', 'tokens.txt', 'lexicon.txt'],
      missing: [],
    };
  }
  if (has(files, /^model.*\.onnx$/i) && hasVocoder && hasTokens) {
    return {
      family: 'matcha',
      engine: null,
      supported: false,
      reason: '这是 Matcha 布局（model + vocoder + tokens，且没有 .onnx.json）。本版暂不支持导入该模型族。',
      required: [],
      missing: [],
    };
  }
  return {
    family: 'unknown',
    engine: null,
    supported: false,
    reason: '判不出模型族。可导入的目录里通常要有 model.onnx + tokens.txt（Kokoro / VITS），或 encoder/decoder + 声码器（ZipVoice）。',
    required: [],
    missing: [],
  };
}

/**
 * 扫描并给出导入决策（不复制）。
 * @param {string} dir
 */
function probe(dir) {
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: '目录不存在' };
  let st = null;
  try { st = fs.statSync(dir); } catch { /* ignore */ }
  if (!st || !st.isDirectory()) return { ok: false, error: '请选择一个目录（不是单个文件）' };

  const { files, truncated } = listFiles(dir);
  if (!files.length) return { ok: false, error: '目录是空的' };
  if (truncated) return { ok: false, error: `目录文件过多（超过 ${MAX_FILES} 个），请确认选的是单个音色包而不是整个模型仓库` };

  const bytes = files.reduce((n, f) => n + (f.size || 0), 0);
  if (bytes > MAX_PACK_BYTES) {
    return {
      ok: false,
      error: `目录 ${(bytes / 1024 / 1024).toFixed(0)}MB，超过单包上限 ${MAX_PACK_BYTES / 1024 / 1024}MB。请只选单个音色包目录。`,
    };
  }

  const det = detect(files);
  // 多说话人：vits 从 json 的 num_speakers 读；kokoro 读不到就交给运行时
  let numSpeakers = 1;
  if (det.family === 'vits') {
    const jsonFile = files.find((f) => atRoot(f) && f.name.endsWith('.onnx.json'));
    if (jsonFile) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, jsonFile.rel), 'utf8'));
        numSpeakers = Number(j.num_speakers) || 1;
      } catch { /* json 坏了：试听会暴露 */ }
    }
  }

  return {
    ok: det.supported,
    family: det.family,
    familyLabel: FAMILY_LABEL[det.family] || det.family,
    engine: det.engine,
    /** vits 里区分「已转换（可直接用）」与「原生 Piper（必须转换）」 */
    kind: det.kind || '',
    supported: det.supported,
    reason: det.reason,
    error: det.supported ? '' : det.reason,
    required: det.required,
    missing: det.missing,
    /** vits 需要 espeak-ng-data 做音素化；包内没带时要回落到已安装的内置包（MeloTTS 例外：它不需要）*/
    needsEspeak: det.engine === 'vits' && det.kind !== 'melo'
      && !files.some((f) => f.dir && /^espeak-ng-data$/i.test(baseName(f))),
    numSpeakers,
    bytes,
    fileCount: files.filter((f) => !f.dir).length,
    dir,
  };
}

/** 这个包是否依赖外部 espeak-ng-data（vits 系），且自己没带 */
function needsEspeakData(dir, engine) {
  if (engine !== 'vits') return false;
  const { files } = listFiles(dir);
  // MeloTTS 用 lexicon + 自带分词表，塞 espeak 目录反而加载失败
  if (isMeloLayout(files)) return false;
  return !files.some((f) => f.dir && /^espeak-ng-data$/i.test(baseName(f)));
}

/** 从探测结果 + 目录，拼运行时引擎配置（用绝对路径；worker 不碰相对路径） */
function buildEngineConfig(dir, engine, opts = {}) {
  const { files } = listFiles(dir);
  const abs = (f) => path.join(dir, f.rel);
  const numThreads = Math.max(1, Math.min(4, Math.ceil(require('node:os').cpus().length / 2)));
  if (engine === 'zipvoice') {
    const enc = find(files, /^encoder.*\.onnx$/i);
    const dec = find(files, /^decoder.*\.onnx$/i);
    const voc = find(files, /^(vocoder|vocos).*\.onnx$/i);
    const tokens = find(files, /^tokens\.txt$/i);
    const lexicon = findLexicon(files);
    const espeak = files.find((f) => f.dir && /^espeak-ng-data$/i.test(baseName(f)));
    return {
      engine: 'zipvoice',
      encoder: enc ? abs(enc) : '',
      decoder: dec ? abs(dec) : '',
      vocoder: voc ? abs(voc) : '',
      tokens: tokens ? abs(tokens) : '',
      dataDir: espeak ? path.join(dir, espeak.rel) : '',
      lexicon: lexicon ? abs(lexicon) : '',
      numThreads,
    };
  }
  if (engine === 'vits') {
    const model = files.find((f) => atRoot(f) && /\.onnx$/i.test(f.name) && files.some((x) => x.name === `${f.name}.json`));
    // MeloTTS 没有 .onnx.json（上面那条按同名 json 找不到 model），单独取精确名 model.onnx
    const melo = isMeloLayout(files);
    const meloModel = melo ? find(files, /^model\.onnx$/i) : null;
    const tokens = find(files, /^tokens\.txt$/i);
    const lexicon = findLexicon(files);
    const espeak = files.find((f) => f.dir && /^espeak-ng-data$/i.test(baseName(f)));
    const dictDir = files.find((f) => f.dir && /^(dict|espeak-ng-data)$/i.test(baseName(f)));
    return {
      engine: 'vits',
      model: model ? abs(model) : meloModel ? abs(meloModel) : '',
      tokens: tokens ? abs(tokens) : '',
      lexicon: lexicon ? abs(lexicon) : '',
      // 自己带的优先；包内没有时借用调用方给的内置包（社区包常常只发模型，不发 13MB 音素数据）。
      // MeloTTS 一律留空：它的 dict/ 是分词表不是音素数据，传下去必报 dict/phontab 不存在。
      dataDir: melo ? '' : espeak ? path.join(dir, espeak.rel) : dictDir ? path.join(dir, dictDir.rel) : String(opts.fallbackDataDir || ''),
      numThreads,
    };
  }
  // kokoro（含用户导入的 Kokoro 包）
  const model = find(files, /^model.*\.onnx$/i);
  const voices = find(files, /^voices\.bin$/i);
  const tokens = find(files, /^tokens\.txt$/i);
  const lexicon = findLexicon(files);
  const espeak = files.find((f) => f.dir && /^espeak-ng-data$/i.test(baseName(f)));
  return {
    engine: 'kokoro',
    model: model ? abs(model) : '',
    voices: voices ? abs(voices) : '',
    tokens: tokens ? abs(tokens) : '',
    lexicon: lexicon ? abs(lexicon) : '',
    dataDir: espeak ? path.join(dir, espeak.rel) : '',
    numThreads,
    // 导入包的多说话人 id 由用户在导入时选（默认 0）；内置音色走 sid
    sid: Math.max(0, Math.round(Number(opts.sid) || 0)),
  };
}

module.exports = {
  probe,
  detect,
  buildEngineConfig,
  needsEspeakData,
  findLexicon,
  isMeloLayout,
  listFiles,
  MAX_PACK_BYTES,
  FAMILY_LABEL,
};
