// 智联「列表卡无 JD」补齐回归断言（零新增依赖）
//
// 为什么需要它：内置浏览器列表级采集打开的智联搜索页（旧版 /sou/ 卡、新版 /jobs/ 卡）**卡片 DOM 里
// 没有 JD**，旧实现把整卡文本当描述入库 → 岗位「没有 JD」（实测入库描述 =
// 「数仓后端开发（实习生） 130-150元/天 本科 数据开发 立邦投资有限公司 上海 浦东 花木」），
// AI 评分输入与工作制度/福利标签推导全部失真。
// 现由 `electron/preload/webview.cjs::enrichZhaopinJobDetail()` 按卡片的 number 调平台自身
// 职位详情接口（`fe-api.zhaopin.com/c/i/jobs/position-detail-new`）取回完整 JD。
// 本脚本守住这条链路的三个可离线验证的契约：
//   ① number 解析（`jobdetail/CC…J….htm` → `CC…J…`，且绝不把哈希兜底身份当 number 打接口）；
//   ② 详情载荷 → 补齐字段（JD 保真：**保留换行与分段标题**、剥净 HTML、不压成一行；技能/HR 取到）；
//   ③ 失败/异常载荷一律返回 null（调用方保持卡片文本兜底，绝不丢岗位）。
//
// 夹具为 2026-09 真机响应节选（岗位：数仓后端开发（实习生）· 立邦投资有限公司）。
//
// 用法：node scripts/zhaopin-jd-regression.mjs    （EXIT 0 = 全通过，1 = 有失败）
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) pass += 1;
  else failures.push(`${name}${detail ? `\n      ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `期望：${e}\n      实际：${a}`);
}

// ===== 真机响应夹具（节选：只保留本链路用到的字段）=====
const FIXTURE = {
  code: 200,
  data: {
    detailedPosition: {
      number: 'CC000100540J41023445004',
      positionName: '数仓后端开发（实习生）',
      jobDesc: '岗位职责<br>1.参与公司数据仓库的模型设计与开发,协助完成ETL数据抽取,转换与加载流程的开发与维护;<br>2.使用T-SQL编写存储过程,触发器等数据库对象,保障数据仓库后端逻辑的稳定与高效;<br>3.参与数据可视化需求的对接,协助将数据仓库成果转化为可供业务使用的可视化报表与数据服务;<br>岗位要求<br>1.熟悉T-SQL语法,具备一定的存储过程,触发器等数据库对象的开发经验;<br>2.熟悉至少一款主流ETL工具(如Informatica, Talend, Kettle, SSIS等);<br>你将获得<br>1.接触企业级数据仓库建设全流程,深入了解数据资产治理与数据治理实践;<br>2.在同事指导下参与真实项目,积累数据开发与数据治理实战经验.<br>',
      skillLabel: [{ state: 0, value: '数据开发' }],
      welfareLabel: [],
      salary60: '130-150元/天',
      cityDistrict: '浦东新区',
      workCity: '上海',
      staff: { staffName: '申女士', hrJob: 'HRBP' },
    },
  },
};

try {
  const A = require(`${root.replace(/\\/g, '/')}/electron/preload/platform-adapters.cjs`);
  const {
    zhaopinJobNumber, zhaopinJobDetailUrl, jdHtmlToText, toStringTags,
    parseZhaopinJobDetail, PLATFORM_DETAIL_API_FILL, PLATFORM_FIELD_SELECTORS,
  } = A;

  // ---------- ① number 解析 ----------
  eq('jobId 带 .htm 后缀', zhaopinJobNumber('CC000100540J41023445004.htm'), 'CC000100540J41023445004');
  eq('完整详情 URL（带 query）', zhaopinJobNumber('https://www.zhaopin.com/jobdetail/CCL1525276270J40939494612.htm?srccode=401903'), 'CCL1525276270J40939494612');
  eq('http（旧版卡锚点形态）', zhaopinJobNumber('http://www.zhaopin.com/jobdetail/CC284089130J40865257109.htm'), 'CC284089130J40865257109');
  eq('哈希兜底身份 → 不打接口', zhaopinJobNumber('f1abc2x'), '');
  eq('搜索页 URL → 不打接口', zhaopinJobNumber('https://www.zhaopin.com/sou/jl489/p1?kw=x'), '');
  eq('空值', zhaopinJobNumber(''), '');

  // ---------- 接口 URL ----------
  ok('详情接口 URL 形态', zhaopinJobDetailUrl('CC000100540J41023445004') === 'https://fe-api.zhaopin.com/c/i/jobs/position-detail-new?number=CC000100540J41023445004',
    zhaopinJobDetailUrl('CC000100540J41023445004'));
  ok('number 做 URL 编码', zhaopinJobDetailUrl('a b&c').endsWith('number=a%20b%26c'), zhaopinJobDetailUrl('a b&c'));

  // ---------- ② JD 保真（HTML → 文本）----------
  eq('br 转行且保留分段', jdHtmlToText('岗位职责<br>1.做事<br>任职要求<br>2.做人'), '岗位职责\n1.做事\n任职要求\n2.做人');
  eq('块级标签转行', jdHtmlToText('<div>a</div><div>b</div>'), 'a\nb');
  eq('行内标签剥除不换行', jdHtmlToText('熟练<span>Java</span>与<b>SQL</b>'), '熟练Java与SQL');
  eq('实体解码', jdHtmlToText('A&amp;B&nbsp;C&lt;D&gt;'), 'A&B C<D>');
  eq('多余空行折叠', jdHtmlToText('a<br><br><br><br>b'), 'a\n\nb');
  eq('空载荷', jdHtmlToText(''), '');
  eq('null 载荷', jdHtmlToText(null), '');

  // ---------- 标签字段容错 ----------
  eq('标签：对象数组（value）', toStringTags([{ value: '数据开发' }]), ['数据开发']);
  eq('标签：对象数组（name）', toStringTags([{ name: 'D轮及以上' }]), ['D轮及以上']);
  eq('标签：字符串数组', toStringTags(['五险一金', '双休']), ['五险一金', '双休']);
  eq('标签：裸字符串', toStringTags('周末双休'), ['周末双休']);
  eq('标签：去重 + 剔空', toStringTags([{ value: 'x' }, { value: 'x' }, { value: '' }, null]), ['x']);
  eq('标签：空值', toStringTags(null), []);

  // ---------- 载荷 → 补齐字段 ----------
  const parsed = parseZhaopinJobDetail(FIXTURE);
  ok('载荷可解析', Boolean(parsed));
  const jd = parsed?.description || '';
  ok('JD 非空且为完整正文（> 200 字）', jd.length > 200, `实际长度 ${jd.length}`);
  ok('JD 保留分段标题（保真红线）', jd.includes('岗位职责') && jd.includes('岗位要求') && jd.includes('你将获得'),
    jd.slice(0, 120));
  ok('JD 保留换行（未被压成一行）', jd.split('\n').filter(Boolean).length >= 5, `行数 ${jd.split('\n').length}`);
  ok('JD 已剥净 HTML 标签', !jd.includes('<') && !jd.includes('>') && !jd.includes('br>'), jd.slice(0, 120));
  ok('JD 不是「整卡文本」冒充（用户报告的 bug 形态）',
    !/^数仓后端开发（实习生）\s+\d+-\d+元\/天/.test(jd), jd.slice(0, 80));
  eq('技能标签', parsed?.skills, ['数据开发']);
  eq('福利标签（空载荷 → 空数组，不臆造）', parsed?.welfare, []);
  eq('HR 姓名', parsed?.recruiterName, '申女士');
  eq('HR 职位', parsed?.recruiterTitle, 'HRBP');

  // ---------- ③ 异常载荷 → null（保持卡片兜底）----------
  eq('null', parseZhaopinJobDetail(null), null);
  eq('空对象', parseZhaopinJobDetail({}), null);
  eq('无 data', parseZhaopinJobDetail({ code: 200 }), null);
  eq('data 为空', parseZhaopinJobDetail({ code: 200, data: {} }), null);
  eq('detailedPosition 为 null', parseZhaopinJobDetail({ code: 200, data: { detailedPosition: null } }), null);
  eq('业务失败码', parseZhaopinJobDetail({ code: 500, data: null }), null);

  // ---------- 能力表 + 旧版 /sou/ 卡字段选择器（防回退）----------
  eq('补齐能力表只开智联', PLATFORM_DETAIL_API_FILL, { zhaopin: true });
  const zp = PLATFORM_FIELD_SELECTORS.zhaopin;
  ok('旧版 /sou/ 卡标题选择器', zp.title.includes('.jobinfo__name'), zp.title.join(','));
  ok('旧版 /sou/ 卡公司选择器', zp.company.includes('.companyinfo__name'), zp.company.join(','));
  ok('旧版 /sou/ 卡地点选择器', zp.location.indexOf('.jobinfo__other-info-item') === 0, zp.location.join(','));
  ok('旧版 /sou/ 卡薪资选择器', zp.salary.includes('.jobinfo__salary'), zp.salary.join(','));
} catch (err) {
  failures.push(`导入/执行失败：${err?.message || err}`);
}

if (failures.length) {
  console.error(`\n[智联 JD 补齐回归] 失败 ${failures.length} 项 / 通过 ${pass} 项\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exitCode = 1;
} else {
  console.log(`[智联 JD 补齐回归] 全部通过：${pass} 项断言`);
}
