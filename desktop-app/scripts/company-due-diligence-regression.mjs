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
        "export { buildSearchLinks, buildOfficialLinks, extractNegativeSignals, pickSourceLink, signalHeadline, distinctSourceCount, buildRatingMessages, parseRating, ratingStale, RISK_LEVEL_LABEL, sourceTierOf, SOURCE_TIER_LABEL, mentionsCompany, companyCoreTokens, signalYear, isStaleSignal, mergeSignals, appendScan, summarizeSignals, signalCoverageNote, quoteMatchesSource, buildDueDiligenceReport, dueDiligenceTag } from './src/lib/bossclaw/companyDueDiligence.ts';",
        "export { isWhitelistedUrl, WHITELIST_GROUPS } from './src/lib/bossclaw/browserWhitelist.ts';",
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
  eq('默认生成三组查询（欠薪/投诉/社保合同）', links.length, 3);
  ok('链接指向 Bing 且带上公司名', /^https:\/\/www\.bing\.com\/search\?q=/.test(links[0].url) && decodeURIComponent(links[0].url).includes('某某科技有限公司'), links[0].url);
  ok('查询词包含劳资纠纷关键词', /欠薪/.test(links[0].query) && /劳动仲裁/.test(links[0].query));
  ok('第二组盯投诉/曝光', /骗局/.test(links[1].query) && /曝光/.test(links[1].query));
  ok('第三组盯社保/合同', /不缴社保/.test(links[2].query) && /劳动合同/.test(links[2].query));
  ok('可切换到百度', /^https:\/\/www\.baidu\.com\/s\?wd=/.test(M.buildSearchLinks('A公司', 'baidu')[0].url));

  // ===== A2. 官方核查入口 =====
  eq('空公司名不生成官方入口', M.buildOfficialLinks('').length, 0);
  const official = M.buildOfficialLinks('某某科技有限公司');
  eq('官方入口 5 个（工商/信用/失信/被执行/裁判文书）', official.length, 5);
  ok('官方入口覆盖工商公示', official.some((l) => /gsxt\.gov\.cn/.test(l.url)));
  ok('官方入口覆盖信用中国', official.some((l) => /creditchina\.gov\.cn/.test(l.url)));
  ok('官方入口覆盖执行信息公开网（失信 + 被执行）', official.filter((l) => /zxgk\.court\.gov\.cn/.test(l.url)).length === 2);
  ok('官方入口覆盖裁判文书网', official.some((l) => /wenshu\.court\.gov\.cn/.test(l.url)));

  // ===== A2·B. 内置浏览器白名单必须放行背调链路 =====
  ok('背调搜索站点在白名单内', [
    'https://www.bing.com/search?q=test',
    'https://www.baidu.com/s?wd=test',
    'https://www.sogou.com/web?query=test',
  ].every((u) => M.isWhitelistedUrl(u)));
  ok('官方核查站点在白名单内', official.map((l) => l.url).every((u) => M.isWhitelistedUrl(u)));
  eq('非白名单站点仍被拦截', M.isWhitelistedUrl('https://example.com/post/1'), false);
  ok('便签页包含背调分组', M.WHITELIST_GROUPS.some((g) => g.group === 'dueDiligence' && /背调/.test(g.label)));

  // ===== A3. 来源分级 =====
  eq('官方域名 → official', M.sourceTierOf('https://www.creditchina.gov.cn/xinyongxinxi/1'), 'official');
  eq('gov.cn 子域 → official', M.sourceTierOf('https://www.samr.gov.cn/zw/1'), 'official');
  eq('招聘平台 → jobboard', M.sourceTierOf('https://www.zhipin.com/gongsi/abc.html'), 'jobboard');
  eq('媒体 → media', M.sourceTierOf('https://news.163.com/25/1117/1.html'), 'media');
  eq('社区 → forum', M.sourceTierOf('https://www.zhihu.com/question/1'), 'forum');
  eq('未知域名 → unknown', M.sourceTierOf('https://example.com/post/1'), 'unknown');
  eq('空 URL → unknown', M.sourceTierOf(''), 'unknown');
  eq('非法 URL → unknown', M.sourceTierOf('not-a-url'), 'unknown');
  eq('官方来源中文标签', M.SOURCE_TIER_LABEL.official, '官方来源');

  // ===== A4. 同名判定 / 年份 =====
  ok('全称命中 → 提到该公司', M.mentionsCompany('某某科技有限公司因欠薪被投诉', '某某科技有限公司'));
  ok('去掉地区与后缀的核心词命中 → 提到该公司', M.mentionsCompany('三快在线员工爆料', '北京三快在线科技有限公司'));
  ok('完全无关的公司 → 未提到', !M.mentionsCompany('另一家某某贸易公司拖欠货款', '北京三快在线科技有限公司'));
  eq('核心词包含全称', M.companyCoreTokens('某某科技有限公司').includes('某某'), true);
  eq('信号年份：2025 年', M.signalYear('2025 年多名员工申请劳动仲裁', 2026), 2025);
  eq('信号年份：去年', M.signalYear('去年发生欠薪', 2026), 2025);
  eq('取不到年份 → undefined', M.signalYear('员工反映拖欠工资', 2026), undefined);
  eq('两年前信息算旧信息', M.isStaleSignal({ year: 2024 }, 2026), true);
  eq('近两年信息不算旧信息', M.isStaleSignal({ year: 2025 }, 2026), false);

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

  // ===== B2. 扩充规则（社保 / 合同 / 安全 / 供应商 / 招聘收费）=====
  const social = M.extractNegativeSignals('员工反映公司不缴社保、断缴公积金', { url: 'https://www.zhihu.com/q/1' });
  ok('社保欠缴 → insurance', social.some((s) => s.category === 'insurance'), JSON.stringify(social.map((s) => s.category)));
  const contract = M.extractNegativeSignals('入职半年公司不签劳动合同', { url: 'u' });
  ok('不签劳动合同 → contract', contract.some((s) => s.category === 'contract'));
  const safetyStrong = M.extractNegativeSignals('工厂发生安全事故，造成 1 人死亡', { url: 'u' });
  ok('安全事故 + 死亡 → safety', safetyStrong.some((s) => s.category === 'safety'));
  eq('只有「安全事故」没有伤亡语境 → 不产出', M.extractNegativeSignals('公司开展安全事故演练', { url: 'u' }).filter((s) => s.category === 'safety').length, 0);
  const supplier = M.extractNegativeSignals('多家供应商投诉该公司拖欠货款', { url: 'u' });
  ok('拖欠货款 → supplier', supplier.some((s) => s.category === 'supplier'));
  const recruit = M.extractNegativeSignals('面试时要求交培训费，疑似培训贷', { url: 'u' });
  ok('培训贷 → recruit', recruit.some((s) => s.category === 'recruit'));
  const operation = M.extractNegativeSignals('该公司被列入经营异常名录', { url: 'u' });
  ok('经营异常名录 → operation', operation.some((s) => s.category === 'operation'));

  // 共现只看命中附近：长文里相隔很远的「罚款」与「行政处罚」不能拼成一条信号
  const farApart = '公司被罚款' + '正常业务介绍'.repeat(80) + '行政处罚';
  eq('共现词相隔过远 → 不产出处罚信号', M.extractNegativeSignals(farApart, { url: 'u' }).filter((s) => s.category === 'penalty').length, 0);

  // ===== B3. 来源分级 / 同名 / 年份 落到信号上 =====
  const enriched = M.extractNegativeSignals('某某科技有限公司 2024 年因拖欠工资被劳动仲裁', {
    url: 'https://www.creditchina.gov.cn/xinyongxinxi/abc',
    company: '某某科技有限公司',
  });
  const enrichedWage = enriched.find((s) => s.category === 'wage');
  ok('信号带官方来源分级', enrichedWage && enrichedWage.tier === 'official', JSON.stringify(enrichedWage));
  eq('信号带年份', enrichedWage && enrichedWage.year, 2024);
  eq('片段出现公司名 → matched', enrichedWage && enrichedWage.identity, 'matched');
  const unclear = M.extractNegativeSignals('另一家公司拖欠工资，员工申请劳动仲裁', {
    url: 'https://www.zhihu.com/q/2',
    company: '某某科技有限公司',
  });
  eq('片段没出现公司名 → unclear', unclear.find((s) => s.category === 'wage')?.identity, 'unclear');

  // ===== B4. 多页累积合并 =====
  const scanA = M.extractNegativeSignals('员工反映拖欠工资，2025 年申请劳动仲裁。', { url: 'https://a.test/1', company: '某某科技有限公司' });
  const scanB = M.extractNegativeSignals('该公司因虚假宣传被行政处罚，罚款 20 万元。', { url: 'https://b.test/2', company: '某某科技有限公司' });
  const merged = M.mergeSignals(scanA, scanB);
  eq('合并保留两页证据', merged.length, scanA.length + scanB.length);
  ok('合并后编号连续', merged.every((s, i) => s.id === `S${i + 1}`), JSON.stringify(merged.map((s) => s.id)));
  eq('重复读取同一页不新增', M.mergeSignals(merged, scanA).length, merged.length);
  const manyWage = Array.from({ length: 5 }, (_, i) => ({
    id: `S${i + 1}`, category: 'wage', label: '欠薪', keyword: '欠薪', snippet: `欠薪线索 ${i}`, sourceUrl: `https://a.test/${i}`, weight: 3,
  }));
  eq('合并时同类别默认最多 3 条', M.mergeSignals([], manyWage).length, 3);
  eq('扫描记录只留最近 10 次', M.appendScan(
    Array.from({ length: 12 }, (_, i) => ({ url: `u${i}`, scannedAt: i, hits: 0, added: 0 })),
    { url: 'latest', scannedAt: 99, hits: 1, added: 1 }
  ).length, 10);

  // ===== B5. 证据概况 =====
  const statsSample = [
    { id: 'S1', category: 'wage', label: '欠薪', keyword: '欠薪', snippet: '拖欠工资', sourceUrl: 'https://www.creditchina.gov.cn/1', weight: 3, tier: 'official', year: 2025, identity: 'matched' },
    { id: 'S2', category: 'layoff', label: '裁员', keyword: '裁员', snippet: '暴力裁员', sourceUrl: 'https://www.zhihu.com/2', weight: 1, tier: 'forum', year: 2023, identity: 'unclear' },
  ];
  const stats = M.summarizeSignals(statsSample, 2026);
  eq('概况：总条数', stats.total, 2);
  eq('概况：高权重', stats.high, 1);
  eq('概况：低权重', stats.low, 1);
  eq('概况：来源数', stats.distinctSources, 2);
  eq('概况：官方来源数', stats.officialSources, 1);
  eq('概况：同名待核实', stats.identityUnclear, 1);
  eq('概况：旧信息', stats.stale, 1);
  eq('概况：最新年份', stats.latestYear, 2025);
  eq('概况：非单一来源', stats.singleSource, false);
  ok('概况文案包含官方来源与同名待核实', /官方来源/.test(M.signalCoverageNote(stats)) && /未确认指向该公司/.test(M.signalCoverageNote(stats)));
  ok('无信号概况明说「不等于没有风险」', /不等于公司没有风险/.test(M.signalCoverageNote(M.summarizeSignals([]))));

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

  // ===== C2. 引用原文逐字校验（对标 due-diligence-agents 的 citation fidelity）=====
  const sourceTexts = {
    A: '经营状态：存续（在营、开业、在册）；参保人数：128 人',
    S1: '有员工反映该公司存在拖欠工资情况，2025 年多名员工申请劳动仲裁。',
    S2: '该公司因虚假宣传被行政处罚，罚款 20 万元。',
  };
  ok('quote 逐字命中', M.quoteMatchesSource('2025 年多名员工申请劳动仲裁', sourceTexts.S1));
  ok('quote 去掉空白与标点后仍命中', M.quoteMatchesSource('2025年多名员工申请劳动仲裁。', sourceTexts.S1));
  ok('quote 用省略号分段校验', M.quoteMatchesSource('2025 年…劳动仲裁', sourceTexts.S1));
  ok('quote 改写后不命中', !M.quoteMatchesSource('2025 年多名员工集体申请仲裁', sourceTexts.S1));
  ok('quote 为空不命中', !M.quoteMatchesSource('', sourceTexts.S1));

  const verified = M.parseRating(JSON.stringify({
    level: 'high',
    summary: '有明确欠薪与仲裁报道。',
    reasons: [{ text: '存在欠薪与劳动仲裁，入职前应核实。', sources: ['S1'], quote: '拖欠工资' }],
  }), sourceTexts);
  eq('quote 命中 → 保留依据', verified.reasons.length, 1);
  eq('quote 原样保留供展示', verified.reasons[0].quote, '拖欠工资');
  eq('quote 命中 → 标记已验证', verified.reasons[0].quoteVerified, true);

  const badQuote = M.parseRating(JSON.stringify({
    level: 'high',
    summary: 's',
    reasons: [{ text: '公司资金链断裂', sources: ['S1'], quote: '公司资金链断裂' }],
  }), sourceTexts);
  eq('quote 引不到原文 → 依据仍保留（不因转述让评级整体失败）', badQuote.reasons.length, 1);
  eq('quote 引不到原文 → 丢弃该引用', badQuote.reasons[0].quote, undefined);

  const narrowed = M.parseRating(JSON.stringify({
    level: 'medium',
    summary: 's',
    reasons: [{ text: '有欠薪报道，需核实。', sources: ['S1', 'A'], quote: '拖欠工资' }],
  }), sourceTexts);
  eq('quote 只命中一个来源时只保留那个来源', narrowed.reasons[0].sources.join(','), 'S1');

  const noQuote = M.parseRating(JSON.stringify({
    level: 'medium',
    summary: 's',
    reasons: [{ text: '有欠薪报道。', sources: ['S1'] }],
  }), sourceTexts);
  eq('未提供 quote → 仍按来源编号保留（兼容旧模型）', noQuote.reasons.length, 1);

  const tolerant = M.parseRating(JSON.stringify({
    level: '高风险',
    summary: 's',
    reasons: [
      { text: '有欠薪报道。', sources: ['来源 S1', '[S2]'] },
      { text: '工商状态正常。', sources: ['工商字段'] },
      { text: '再引一条来源。', sources: ['来源1'] },
    ],
  }), sourceTexts);
  eq('中文等级「高风险」→ high', tolerant.level, 'high');
  eq('来源写法容错（来源 S1 / [S2]）', tolerant.reasons[0].sources.join(','), 'S1,S2');
  eq('来源写法容错（工商字段 → A）', tolerant.reasons[1].sources.join(','), 'A');
  eq('来源写法容错（来源1 → S1）', tolerant.reasons[2].sources.join(','), 'S1');

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
  ok('prompt 要求逐字引用原文', /quote/.test(promptText) && /逐字/.test(promptText));
  ok('prompt 带上证据概况', /证据概况/.test(promptText) && /同名待核实/.test(promptText));
  ok('prompt 带上来源层级与年份', /来源层级/.test(promptText) && /年份/.test(promptText));
  const emptyMsgs = M.buildRatingMessages({ company: 'A', signals: [] }).map((m) => m.content).join('\n');
  ok('无信号时 prompt 明写「未采集到负面信号」', /未采集到负面信号/.test(emptyMsgs));

  // ===== D2. 报告与卡片摘要 =====
  const now = Date.UTC(2026, 10, 16);
  const report = M.buildDueDiligenceReport({
    company: '某某科技有限公司',
    state: {
      signals: statsSample,
      scans: [{ url: 'https://www.bing.com/search?q=test', scannedAt: now, hits: 2, added: 2 }],
      rating: {
        level: 'medium',
        summary: '有一条欠薪报道，需核实是否同名企业。',
        reasons: [{ text: '出现欠薪报道，入职前应核实。', sources: ['S1'], quote: '拖欠工资' }],
        model: 'test-model',
        createdAt: now,
        sourceIds: ['A', 'S1', 'S2'],
      },
    },
  });
  ok('报告含标题与公司名', report.includes('# 企业背调报告') && report.includes('某某科技有限公司'));
  ok('报告含非权威声明', /非权威结论/.test(report));
  ok('报告含信号编号', report.includes('| S1 |'));
  ok('报告含引用原文', /引用原文/.test(report));
  ok('报告含官方核查入口', /creditchina\.gov\.cn/.test(report));
  ok('报告含读取记录', /读取记录/.test(report));

  eq('无评级 → 卡片不出标签', M.dueDiligenceTag(undefined), null);
  eq('低风险 → 卡片不出标签', M.dueDiligenceTag({ signals: [], rating: { level: 'low', summary: '', reasons: [], createdAt: 1, sourceIds: [] } }), null);
  ok('中风险 → 卡片出提示标签', M.dueDiligenceTag({ signals: [], rating: { level: 'medium', summary: 's', reasons: [], createdAt: 1, sourceIds: [] } })?.text === '背调·中风险');
  ok('高风险 → 卡片出提示标签', M.dueDiligenceTag({ signals: [], rating: { level: 'high', summary: 's', reasons: [], createdAt: 1, sourceIds: [] } })?.text === '背调·高风险');
  const freshTag = M.dueDiligenceTag({
    signals: [{ id: 'S1' }],
    rating: { level: 'high', summary: 's', reasons: [], createdAt: Date.now(), sourceIds: ['A', 'S1'] },
  });
  eq('依据未变 → 卡片标签不提示重算', freshTag?.stale, false);
  const staleTag = M.dueDiligenceTag({
    signals: [{ id: 'S1' }, { id: 'S2' }],
    rating: { level: 'high', summary: 's', reasons: [], createdAt: Date.now(), sourceIds: ['A', 'S1'] },
  });
  eq('依据集合变化 → 卡片标签提示重算', staleTag?.stale, true);

  // ===== E. 评级是否该重算 =====
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
  ok('quote 校验在解析阶段执行', /quoteMatchesSource\(quote/.test(lib));
  ok('quote 校验失败只忽略引用、不丢依据', /quoteOut = ''/.test(lib));
  ok('AI 评级不预先拒绝无 Key（允许 agent 代答）', !/请先在「设置」页填写 AI API Key/.test(lib));
  ok('官方入口不拼接不可靠的查询参数（只给站点入口）', /gsxt\.gov\.cn\/index\.html/.test(lib) && /creditchina\.gov\.cn\//.test(lib));

  const preload = read('electron/preload/webview.cjs');
  ok('page-read 返回正文链接（否则信号挂不到具体来源）', /links:\s*\(\(\)\s*=>/.test(preload));

  const wb = read('src/pages/Workbench.tsx');
  ok('工作台渲染背调面板', /<CompanyDueDiligencePanel/.test(wb));
  ok('扫描结果写回 pending.job.dueDiligence', /dueDiligence\s*\}\s*\)/.test(wb) || /job:\s*\{\s*\.\.\.\(p\.job \|\| \{\}\),\s*dueDiligence/.test(wb));
  ok('岗位卡渲染背调提示标签（只提示）', /dueDiligenceTag\(p\.job\?\.dueDiligence\)/.test(wb));

  const panel = read('src/components/CompanyDueDiligencePanel.tsx');
  ok('面板写明「只提示，不参与投递判定」', /不参与投递判定/.test(panel));
  ok('面板不改岗位状态（只写 dueDiligence）', !/updatePending|status:\s*'/.test(panel));
  ok('未配置 Key 时说明会尝试 agent', /未配置 API Key/.test(panel) && /agent/.test(panel));
  ok('AI 按钮不再被「无 Key」禁用（仍有信号即可点）', /disabled=\{!signals\.length\}/.test(panel));
  ok('评级展示标明「非权威」', /非权威/.test(panel));
  ok('依据展示带来源编号', /r\.sources\.map/.test(panel));
  ok('多次读取使用累积合并（不是覆盖）', /mergeSignals\(signals, found\)/.test(panel));
  ok('面板提供官方核查入口', /buildOfficialLinks/.test(panel) && /官方核查/.test(panel));
  ok('打开官方站前复制公司名', /writeText\(company\)/.test(panel));
  ok('面板提供报告复制', /buildDueDiligenceReport/.test(panel) && /复制报告/.test(panel));
  ok('信号行展示来源层级与同名提示', /SOURCE_TIER_LABEL/.test(panel) && /同名待核实/.test(panel));
} catch (e) {
  fails.push('接线守卫读取源码失败 → ' + String((e && e.message) || e));
}

if (fails.length) {
  console.error(`❌ company-due-diligence-regression：${fails.length} 项失败 / ${pass} 项通过`);
  for (const f of fails) console.error('  · ' + f);
  process.exit(1);
}
console.log(`✅ company-due-diligence-regression：${pass} 项全部通过`);
