// company-biz-regression.mjs —— 企业工商信息解析（P1-5 A 层）回归断言
//
// 为什么需要它：A 层的唯一数据源是「公司主页正文文本」，而正文是**非结构化**的 ——
// 同一份字段会有「法定代表人：张三」「法定代表人\n张三」「法定代表人 ： 张 三」多种排版，
// 平台改版还会挪位置。解析写错的表现极其隐蔽：不报错、不崩，只是把「查看详情」当成法人姓名、
// 把「500万美元」折成人民币。这类脏数据一旦落库，用户会当事实读。
//
// 本脚本钉住三件事：
//   ① 解析：多种排版都能取到值；字段格式校验挡掉噪声；一个字段都没有时返回 null（不产空壳）；
//   ② 归一：注册资本按万元、非人民币不折算；日期三种写法；经营状态「吊销」优先于「注销」；
//   ③ 提示：确定性规则只产出能从字段直接推出的结论，且**不做评级、不参与投递判定**。
//
// 用法：node scripts/company-biz-regression.mjs   （EXIT 0 = 全通过，1 = 有失败）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; return; }
  fails.push(name + (detail ? '  → ' + detail : ''));
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}

const dir = mkdtempSync(join(tmpdir(), 'bossclaw-biz-'));
const outfile = join(dir, 'bundle.cjs');
try {
  await build({
    stdin: {
      contents: [
        "export { parseCompanyBizProfile, normalizeCapitalWan, normalizeBizDate, normalizeBizStatus, bizRiskHints, bizProfileFresh, companyPageLike, bizProfileTag } from './src/lib/bossclaw/companyProfile.ts';",
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

  // ===== A. 标准排版（标签与值同行）=====
  const pageA = [
    '某某科技有限公司',
    '公司简介',
    '某某科技成立于 2015 年，专注企业服务。',
    '工商信息',
    '法定代表人：张伟',
    '注册资本：1000万人民币',
    '成立日期：2015-06-01',
    '经营状态：存续（在营、开业、在册）',
    '统一社会信用代码：91110108MA01ABCD2X',
    '注册地址：北京市海淀区中关村大街1号',
    '参保人数：128人',
    '查看更多',
  ].join('\n');
  const a = M.parseCompanyBizProfile(pageA, { url: 'https://www.zhipin.com/gongsi/abc.html', title: '某某科技' });
  ok('标准排版能解析出 profile', Boolean(a), 'parse 返回 null');
  if (a) {
    eq('法人姓名', a.fields.legalPerson, '张伟');
    eq('注册资本原文', a.fields.registeredCapitalText, '1000万人民币');
    eq('注册资本归一（万）', a.fields.registeredCapitalWan, 1000);
    eq('成立日期归一', a.fields.establishedAt, '2015-06-01');
    eq('经营状态归一', a.fields.businessStatus, 'active');
    eq('信用代码', a.fields.creditCode, '91110108MA01ABCD2X');
    eq('注册地址', a.fields.registeredAddress, '北京市海淀区中关村大街1号');
    eq('参保人数', a.fields.insuredCount, 128);
    eq('无缺失字段', a.missing.length, 0);
    eq('来源 URL 落库（可追溯）', a.sourceUrl, 'https://www.zhipin.com/gongsi/abc.html');
    ok('采集时刻落库（用于 30 天新鲜度判定）', Number(a.parsedAt) > 0);
  }

  // ===== B. 分行排版（标签独占一行，值在下一行）=====
  const pageB = ['工商信息', '法定代表人', '李静', '注册资本', '500万元人民币', '成立日期', '2019年3月8日', '经营状态', '在业'].join('\n');
  const b = M.parseCompanyBizProfile(pageB);
  if (b) {
    eq('分行排版：法人', b.fields.legalPerson, '李静');
    eq('分行排版：注册资本', b.fields.registeredCapitalWan, 500);
    eq('分行排版：日期（中文年月日）', b.fields.establishedAt, '2019-03-08');
    eq('分行排版：状态（在业）', b.fields.businessStatus, 'active');
  } else {
    ok('分行排版能解析出 profile', false, 'parse 返回 null —— 分行是最常见的排版，必须支持');
  }

  // ===== C. 全角冒号 / 夹空格 / 同一行塞多组 =====
  const c = M.parseCompanyBizProfile('法定代表人 ： 张 三 注册资本：200万 经营状态：存续');
  if (c) {
    eq('全角冒号 + 夹空格的法人名归一', c.fields.legalPerson, '张三');
    eq('同一行多组字段：注册资本', c.fields.registeredCapitalWan, 200);
    eq('同一行多组字段：经营状态', c.fields.businessStatus, 'active');
  } else {
    ok('同一行塞多组字段能解析', false, 'parse 返回 null');
  }

  // ===== D. 金额归一 =====
  eq('1.2亿 → 12000 万', M.normalizeCapitalWan('1.2亿人民币'), 12000);
  eq('千分位 1,000万 → 1000', M.normalizeCapitalWan('1,000万人民币'), 1000);
  eq('未写单位按万元', M.normalizeCapitalWan('300'), 300);
  eq('美元不折算（不猜汇率）', M.normalizeCapitalWan('500万美元'), undefined);
  eq('港元不折算', M.normalizeCapitalWan('800万港元'), undefined);
  eq('非数字返回 undefined', M.normalizeCapitalWan('暂无'), undefined);

  const usd = M.parseCompanyBizProfile('注册资本：500万美元');
  ok('外币注册资本保留原文', usd && usd.fields.registeredCapitalText === '500万美元', JSON.stringify(usd?.fields));
  ok('外币注册资本不给归一值（避免量纲错误）', usd && usd.fields.registeredCapitalWan === undefined);

  // ===== E. 日期归一 =====
  eq('2015-06-01', M.normalizeBizDate('2015-06-01'), '2015-06-01');
  eq('2015/6/1', M.normalizeBizDate('2015/6/1'), '2015-06-01');
  eq('2015年6月1日', M.normalizeBizDate('2015年6月1日'), '2015-06-01');
  eq('紧凑 20150601', M.normalizeBizDate('20150601'), '2015-06-01');
  eq('非法日期返回 undefined', M.normalizeBizDate('长期'), undefined);
  eq('月份越界返回 undefined', M.normalizeBizDate('2015-13-01'), undefined);

  // ===== F. 经营状态归一（顺序敏感：「吊销，未注销」必须判吊销）=====
  eq('存续', M.normalizeBizStatus('存续（在营、开业、在册）'), 'active');
  eq('吊销，未注销 → revoked', M.normalizeBizStatus('吊销，未注销'), 'revoked');
  eq('注销 → cancelled', M.normalizeBizStatus('注销'), 'cancelled');
  eq('迁出 → moved', M.normalizeBizStatus('迁出'), 'moved');
  eq('认不出的状态 → unknown（不瞎归类）', M.normalizeBizStatus('待核查'), 'unknown');
  eq('空 → unknown', M.normalizeBizStatus(''), 'unknown');

  // ===== G. 噪声与空壳 =====
  const noise = M.parseCompanyBizProfile('注册资本 查看详情\n法定代表人 暂无\n公司简介\n我们是一家好公司');
  eq('无有效字段 → 返回 null（不产空壳 profile）', noise, null);

  const junkState = M.parseCompanyBizProfile('经营状态：待核查');
  ok('认不出的状态词仍保留原文（便于人工判断）', junkState && junkState.fields.businessStatusText === '待核查');
  eq('但归一值为 unknown', junkState?.fields.businessStatus, 'unknown');

  eq('空文本 → null', M.parseCompanyBizProfile(''), null);

  // 缺字段要显式列出（UI 靠它显示「未采集」，不能留空让人误读成「企业没有」）
  const partial = M.parseCompanyBizProfile('法定代表人：王五\n经营状态：注销');
  ok('缺项字段被列进 missing', partial && partial.missing.includes('注册资本') && partial.missing.includes('参保人数'), JSON.stringify(partial?.missing));
  eq('已采字段不进 missing', partial?.missing.includes('法定代表人'), false);

  // ===== H. 风险提示（确定性，不评级）=====
  const dead = M.parseCompanyBizProfile('经营状态：注销\n成立日期：2010-01-01');
  const deadHints = M.bizRiskHints(dead, Date.UTC(2026, 10, 16));
  ok('注销 → 有 warn 级提示', deadHints.some((h) => h.level === 'warn' && /注销/.test(h.text)), JSON.stringify(deadHints));

  const fresh = M.parseCompanyBizProfile('经营状态：存续\n成立日期：2026-08-01');
  const freshHints = M.bizRiskHints(fresh, Date.UTC(2026, 10, 16));
  ok('成立不足半年 → 新公司提示', freshHints.some((h) => /成立仅|新设公司/.test(h.text)), JSON.stringify(freshHints));
  eq('新公司不是 warn（不当成风险结论）', freshHints.some((h) => h.level === 'warn'), false);

  const tiny = M.parseCompanyBizProfile('经营状态：存续\n成立日期：2010-01-01\n注册资本：5万元人民币\n参保人数：0人');
  const tinyHints = M.bizRiskHints(tiny, Date.UTC(2026, 10, 16));
  ok('注册资本 < 10 万 → 提示', tinyHints.some((h) => /注册资本/.test(h.text)));
  ok('参保 0 人 → 提示', tinyHints.some((h) => /参保人数为 0/.test(h.text)));

  const clean = M.parseCompanyBizProfile('法定代表人：张伟\n注册资本：1000万人民币\n成立日期：2010-01-01\n经营状态：存续\n统一社会信用代码：91110108MA01ABCD2X\n注册地址：北京市海淀区中关村大街1号\n参保人数：128人');
  eq('字段齐全且正常 → 无任何提示（不制造虚假风险）', M.bizRiskHints(clean, Date.UTC(2026, 10, 16)).length, 0);

  ok('提示里不出现「高/中/低风险」这种评级措辞', M.bizRiskHints(dead, Date.UTC(2026, 10, 16)).every((h) => !/高风险|中风险|低风险|评级/.test(h.text)));

  // ===== I. 新鲜度 / 页面判定 / 摘要 =====
  const now = Date.UTC(2026, 10, 16);
  ok('1 天前采集 → 新鲜', M.bizProfileFresh({ parsedAt: now - 24 * 3600 * 1000, fields: {}, missing: [], sourceUrl: '' }, now));
  eq('31 天前采集 → 过期', M.bizProfileFresh({ parsedAt: now - 31 * 24 * 3600 * 1000, fields: {}, missing: [], sourceUrl: '' }, now), false);
  eq('没有 profile → 不新鲜', M.bizProfileFresh(undefined, now), false);

  eq('BOSS 公司主页', M.companyPageLike('https://www.zhipin.com/gongsi/abc123.html'), true);
  eq('BOSS 岗位详情页不算公司主页', M.companyPageLike('https://www.zhipin.com/job_detail/xyz.html'), false);
  eq('猎聘公司页', M.companyPageLike('https://www.liepin.com/company/12345/'), true);
  eq('空串不算', M.companyPageLike(''), false);

  eq('注销摘要', M.bizProfileTag(dead), '已注销');
  eq('吊销摘要', M.bizProfileTag(M.parseCompanyBizProfile('经营状态：吊销，未注销')), '已吊销');
  eq('正常 + 有资本 → 注册资本摘要', M.bizProfileTag(clean), '注册 1000 万');
  eq('无 profile → 空摘要', M.bizProfileTag(undefined), '');
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

// ===== J. 接线守卫（UI 口径不能靠人记）=====
const read = (rel) => readFileSync(join(root, rel), 'utf8');
try {
  const types = read('src/lib/bossclaw/types.ts');
  ok('JobMeta 带 companyProfile 字段', /companyProfile\?:\s*CompanyBizProfile/.test(types));
  ok('字段注释写明「不参与投递判定」', /不参与投递判定/.test(types));

  const api = read('src/components/BrowserView.tsx');
  ok('WebviewApi 暴露 readPage（只读抽取当前页）', /readPage:\s*\(tabId\?: string\)\s*=>\s*Promise<any>/.test(api));
  ok('readPage 挂进 apiRef（否则工作台拿不到）', /^\s*readPage,\s*$/m.test(api));

  const wb = read('src/pages/Workbench.tsx');
  ok('工作台渲染 CompanyBizPanel', /<CompanyBizPanel/.test(wb));
  ok('采集结果写回 pending.job.companyProfile（不是只存内存）', /companyProfile:\s*profile/.test(wb));
  ok('岗位卡显示工商摘要标签', /bizProfileTag\(/.test(wb));

  const panel = read('src/components/CompanyBizPanel.tsx');
  ok('面板写明「不参与投递判定」', /不参与投递判定/.test(panel));
  ok('未采集时显式写「未采集」而不是留空', /未采集/.test(panel));
  ok('面板不做状态写入（只提示不拦截）', !/updatePending|status:\s*'/.test(panel));
  ok('页面不对 / 页面对但无区块，两种失败分开提示', /不是公司主页/.test(panel) && /展开「工商信息」/.test(panel));

  const lib = read('src/lib/bossclaw/companyProfile.ts');
  ok('A 层只用页面正文，不引第三方接口', !/fetch\(|axios|http:\/\//.test(lib));
} catch (e) {
  fails.push('接线守卫读取源码失败 → ' + String((e && e.message) || e));
}

if (fails.length) {
  console.error(`❌ company-biz-regression：${fails.length} 项失败 / ${pass} 项通过`);
  for (const f of fails) console.error('  · ' + f);
  process.exit(1);
}
console.log(`✅ company-biz-regression：${pass} 项全部通过`);
