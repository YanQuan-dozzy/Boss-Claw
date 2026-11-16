// company-due-diligence-regression.mjs —— 企业背调 B/C 层回归（负面信号 + AI 评级）
//
// 这两层最容易出的事故不是崩，而是「说了不该说的话」：
//   · B 层把中性词当负面（「裁员」「罚款」大量出现在正常新闻里），用户据此拒掉一个机会；
//   · C 层给出没有出处的结论（「综合来看风险偏高」），用户当成事实；
//   · 评级引用不存在的来源编号（S9），事后无法复核。
// 所以本脚本重点不在覆盖率，而在这些「说不清就别开口」的边界上。
//
// 用法：node scripts/company-due-diligence-regression.mjs   （EXIT 0 = 全通过，1 = 有失败）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

// 最小环境：companyDueDiligence.ts 会带上 llm.ts（内含日志 store 的 localStorage 持久化）
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i) => Array.from(mem.keys())[i] ?? null,
  get length() { return mem.size; },
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

const dir = mkdtempSync(join(tmpdir(), 'bossclaw-dd-'));
const outfile = join(dir, 'bundle.cjs');
try {
  await build({
    stdin: {
      contents: [
        "export { buildSearchLinks, extractNegativeSignals, pickSourceLink, signalHeadline, distinctSourceCount, buildRatingMessages, parseRating, ratingStale, RISK_LEVEL_LABEL } from './src/lib/bossclaw/companyDueDiligence.ts';",
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

  // ===== A. 搜索入口 =====
  eq('空公司名不生成链接', M.buildSearchLinks('').length, 0);
  const links = M.buildSearchLinks('某某科技有限公司');
  eq('默认生成两组查询（欠薪/投诉）', links.length, 2);
  ok('链接指向 Bing 且带上公司名', /^https:\/\/www\.bing\.com\/search\?q=/.test(links[0].url) && decodeURIComponent(links[0].url).includes('某某科技有限公司'), links[0].url);
  ok('查询词包含劳资纠纷关键词', /欠薪/.test(links[0].query) && /劳动仲裁/.test(links[0].query));
  ok('第二组盯投诉/曝光', /骗局/.test(links[1].query) && /曝光/.test(links[1].query));
  ok('可切换到百度', /^https:\/\/www\.baidu\.com\/s\?wd=/.test(M.buildSearchLinks('A公司', 'baidu')[0].url));

  // ===== B. 负面信号提取 =====
  const pageText = [
    '某某科技有限公司怎么样？看准网',
    '有员工反映该公司存在拖欠工资情况，2025 年多名员工申请劳动仲裁。',
    '',
    '某某科技完成 B 轮融资，团队规模扩大',
    '',
    '某大厂宣布裁员 10%，行业整体收缩',
    '',
    '该公司因虚假宣传被行政处罚，罚款 20 万元。',
  ].join('\n');
  const signals = M.extractNegativeSignals(pageText, {
    url: 'https://www.bing.com/search?q=test',
    title: '搜索结果',
    links: [{ text: '有员工反映该公司存在拖欠工资情况', href: 'https://example.com/post/1' }],
  });
  ok('命中欠薪信号', signals.some((s) => s.category === 'wage'), JSON.stringify(signals.map((s) => s.category)));
  ok('命中劳动仲裁信号', signals.some((s) => s.category === 'dispute'));
  ok('命中行政处罚（罚款 + 行政处罚 同段共现）', signals.some((s) => s.category === 'penalty'));
  eq('中性「裁员」报道不产出信号', signals.some((s) => s.category === 'layoff'), false);
  ok('信号编号从 S1 起连续', signals.every((s, i) => s.id === `S${i + 1}`), JSON.stringify(signals.map((s) => s.id)));
  ok('信号带原文片段（用户能自己判断是否同一家公司）', signals.every((s) => s.snippet.length > 8), JSON.stringify(signals.map((s) => s.snippet)));
  const wage = signals.find((s) => s.category === 'wage');
  eq('锚文本命中时挂到具体结果链接', wage && wage.sourceUrl, 'https://example.com/post/1');
  ok('片段里保留关键词本身', wage && wage.snippet.includes('拖欠工资'), wage?.snippet);
  eq('高权重信号标 3 级', wage && wage.weight, 3);

  const weakOnly = M.extractNegativeSignals('公司因违规被罚款', { url: 'u' });
  eq('只有「罚款」没有行政处罚语境 → 不产出', weakOnly.length, 0);

  const layoffWeak = M.extractNegativeSignals('公司宣布优化人员结构', { url: 'u' });
  eq('「优化人员」无强语境 → 不产出', layoffWeak.length, 0);

  const layoffStrong = M.extractNegativeSignals('员工爆料：公司暴力裁员且不给赔偿', { url: 'u' });
  ok('有强语境 → 产出裁员信号（低权重）', layoffStrong.some((s) => s.category === 'layoff' && s.weight === 1), JSON.stringify(layoffStrong));

  const manySame = Array.from({ length: 8 }, (_, i) => `拖欠工资举报 ${i}，员工投诉不断。`).join('\n\n');
  const capped = M.extractNegativeSignals(manySame, { url: 'u' });
  ok('同类别最多 2 条（不刷屏）', capped.filter((s) => s.category === 'wage').length <= 2, JSON.stringify(capped.length));

  eq('空文本 → 无信号', M.extractNegativeSignals('', { url: 'u' }).length, 0);
  eq('pickSourceLink：锚文本不在片段里 → 空', M.pickSourceLink('与链接无关的文本内容', [{ text: '某个标题文字', href: 'https://x.test/1' }]), '');
  eq('pickSourceLink：非 http 链接被忽略', M.pickSourceLink('某个标题文字在这里', [{ text: '某个标题文字', href: 'javascript:alert(1)' }]), '');

  eq('来源域名摘要去掉 www', M.signalHeadline({ label: '欠薪', keyword: '欠薪', sourceUrl: 'https://www.example.com/a', id: 'S1', category: 'wage', snippet: '', weight: 3 }), '欠薪 · 「欠薪」 · 来自 example.com');
  eq('不同来源计数', M.distinctSourceCount([
    { id: 'S1', sourceUrl: 'https://a.test/1' },
    { id: 'S2', sourceUrl: 'https://a.test/1' },
    { id: 'S3', sourceUrl: 'https://b.test/2' },
  ]), 2);

  // ===== C. 评级解析（可解释性优先）=====
  const allowed = ['A', 'S1', 'S2'];
  const good = M.parseRating(JSON.stringify({
    level: 'medium',
    summary: '有一条劳动仲裁报道，仅单一来源，需核实是否同名企业。',
    reasons: [
      { text: '存在劳动仲裁报道，入职前应核实是否有未结争议。', sources: ['S1'] },
      { text: '工商状态正常。', sources: ['A'] },
    ],
  }), allowed);
  eq('正常评级 level', good.level, 'medium');
  eq('依据条数', good.reasons.length, 2);
  eq('来源编号保留', good.reasons[0].sources.join(','), 'S1');
  eq('评级记录候选来源快照（用于判断是否该重算）', good.sourceIds.join(','), 'A,S1,S2');

  let threw = false;
  try { M.parseRating('{"level":"critical","summary":"x","reasons":[{"text":"y","sources":["S1"]}]}', allowed); } catch { threw = true; }
  ok('非法等级（critical）→ 抛错拒收', threw);

  threw = false;
  try {
    M.parseRating('{"level":"high","summary":"风险很高","reasons":[{"text":"综合来看风险偏高","sources":[]}]}', allowed);
  } catch { threw = true; }
  ok('依据无来源 → 全部丢弃后抛错（不接受无出处结论）', threw);

  const filtered = M.parseRating(JSON.stringify({
    level: 'high',
    summary: 's',
    reasons: [
      { text: '无来源的判断', sources: [] },
      { text: '引用不存在编号的判断', sources: ['S9'] },
      { text: '有来源的判断', sources: ['S2'] },
    ],
  }), allowed);
  eq('挂不上来源的依据被丢弃，只留有来源的', filtered.reasons.length, 1);
  eq('留下的那条来源正确', filtered.reasons[0].sources.join(','), 'S2');

  const manyReasons = M.parseRating(JSON.stringify({
    level: 'low',
    summary: 's',
    reasons: Array.from({ length: 9 }, (_, i) => ({ text: `理由 ${i}`, sources: ['S1'] })),
  }), allowed);
  eq('依据最多 5 条', manyReasons.reasons.length, 5);

  threw = false;
  try { M.parseRating('不是 JSON', allowed); } catch { threw = true; }
  ok('非 JSON → 抛错', threw);

  const noText = M.parseRating(JSON.stringify({ level: 'low', summary: 's', reasons: [{ sources: ['S1'] }, { text: '有文本', sources: ['S1'] }] }), allowed);
  eq('缺 text 的依据被丢弃', noText.reasons.length, 1);

  eq('等级中文标签', M.RISK_LEVEL_LABEL.high, '高风险');

  // ===== D. prompt 构造 =====
  const msgs = M.buildRatingMessages({ company: '某某科技', signals: [
    { id: 'S1', category: 'wage', label: '欠薪 / 拖欠工资', keyword: '拖欠工资', snippet: '员工反映拖欠工资', sourceUrl: 'https://a.test/1', weight: 3 },
  ] });
  const promptText = msgs.map((m) => m.content).join('\n');
  ok('prompt 带上信号编号（否则模型无法引用来源）', promptText.includes('"编号": "S1"'));
  ok('prompt 带上工商字段编号 A', promptText.includes('"编号": "A"'));
  ok('prompt 明确「sources 只能取给定编号」', /不得编造编号/.test(promptText));
  ok('prompt 禁止替代用户做决策', /是否投递由用户决定|不得.*不要投递/.test(promptText));
  ok('prompt 提示同名企业风险', /同名企业/.test(promptText));
  const emptyMsgs = M.buildRatingMessages({ company: 'A', signals: [] }).map((m) => m.content).join('\n');
  ok('无信号时 prompt 明写「未采集到负面信号」', /未采集到负面信号/.test(emptyMsgs));

  // ===== E. 评级是否该重算 =====
  const now = Date.UTC(2026, 10, 16);
  eq('没有评级 → 需要重算', M.ratingStale(undefined, now), true);
  const freshState = {
    signals: [{ id: 'S1' }, { id: 'S2' }],
    rating: { level: 'low', summary: '', reasons: [], createdAt: now - 1000, sourceIds: ['A', 'S1', 'S2'] },
  };
  eq('来源集合未变且新鲜 → 不需要重算', M.ratingStale(freshState, now), false);
  eq('新增信号 → 需要重算', M.ratingStale({ ...freshState, signals: [{ id: 'S1' }, { id: 'S2' }, { id: 'S3' }] }, now), true);
  eq('评级超过 30 天 → 需要重算', M.ratingStale({ ...freshState, rating: { ...freshState.rating, createdAt: now - 31 * 24 * 3600 * 1000 } }, now), true);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

// ===== F. 接线守卫 =====
const read = (rel) => readFileSync(join(root, rel), 'utf8');
try {
  const types = read('src/lib/bossclaw/types.ts');
  ok('JobMeta 带 dueDiligence 字段', /dueDiligence\?:\s*DueDiligenceState/.test(types));

  const lib = read('src/lib/bossclaw/companyDueDiligence.ts');
  ok('B 层不自己发网络请求（只解析用户打开页面的正文）', !/\bfetch\(|axios|XMLHttpRequest/.test(lib));
  ok('评级不允许替代用户决策（prompt 里有明文约束）', /不要投递|是否投递由用户决定/.test(lib));
  ok('无来源的依据在解析阶段被丢弃', /无来源 → 丢弃/.test(lib));

  const preload = read('electron/preload/webview.cjs');
  ok('page-read 返回正文链接（否则信号挂不到具体来源）', /links:\s*\(\(\)\s*=>/.test(preload));

  const wb = read('src/pages/Workbench.tsx');
  ok('工作台渲染背调面板', /<CompanyDueDiligencePanel/.test(wb));
  ok('扫描结果写回 pending.job.dueDiligence', /dueDiligence\s*\}\s*\)/.test(wb) || /job:\s*\{\s*\.\.\.\(p\.job \|\| \{\}\),\s*dueDiligence/.test(wb));

  const panel = read('src/components/CompanyDueDiligencePanel.tsx');
  ok('面板写明「只提示，不参与投递判定」', /不参与投递判定/.test(panel));
  ok('面板不改岗位状态（只写 dueDiligence）', !/updatePending|status:\s*'/.test(panel));
  ok('未配置 AI 时明说只展示 A/B', /未配置 AI API Key/.test(panel));
  ok('评级展示标明「非权威」', /非权威/.test(panel));
  ok('依据展示带来源编号', /r\.sources\.map/.test(panel));
} catch (e) {
  fails.push('接线守卫读取源码失败 → ' + String((e && e.message) || e));
}

if (fails.length) {
  console.error(`❌ company-due-diligence-regression：${fails.length} 项失败 / ${pass} 项通过`);
  for (const f of fails) console.error('  · ' + f);
  process.exit(1);
}
console.log(`✅ company-due-diligence-regression：${pass} 项全部通过`);
