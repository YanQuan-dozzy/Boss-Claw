// 猎聘「列表卡无 JD」补齐回归断言（零新增依赖）
//
// 为什么需要它：内置浏览器列表级采集打开的猎聘搜索页，**卡片 DOM 里没有 JD 正文**——
// 卡片只有「标题 / 【城市】 / 薪资 / 标签 / 公司 / HR」（真机样本见下），旧实现把整卡文本当描述入库，
// 于是「岗位匹配」与「定制简历」拿到的岗位是
//   「【红杉成员企业】全栈开发实习生 【 北京-海淀区 】 500元/天 实习 学生可投 本科 红杉中国 基金/证券/期货…」
// 这类**列表摘要**，没有一句职责/要求，AI 评分与简历定制全线失真（用户 2026-10-01 报告）。
//
// 现由 `electron/preload/webview.cjs::enrichJobDetail()` 按卡片 jobId 取**同源详情页 HTML**
// （猎聘详情页是服务端渲染，JD 直接写在 HTML 里），交给
// `electron/preload/platform-adapters.cjs::parseLiepinJobDetailHtml()` 解析。
// 本脚本守住这条链路的三个可离线验证的契约：
//   ① 岗位号 → 详情页 URL（`liepinJobDetailUrl`，含 /job/ 与 SEO /a/ 两种形态，且不误吞哈希兜底身份）；
//   ② 详情页 HTML → 补齐字段（JD 保真：**保留换行与分段标题**、剥净 HTML、不压成一行；
//      标题/薪资/地点/公司/HR 取到；标签区取全且不含「招N人/N月N日更新」噪声）；
//   ③ 异常/无效载荷一律返回 null（调用方保持卡片文本兜底，绝不丢岗位）。
//
// 夹具为 2026-10-01 真机详情页源码节选（岗位：【红杉成员企业】全栈开发实习生 · 红杉中国）。
//
// 用法：node scripts/liepin-jd-regression.mjs    （EXIT 0 = 全通过，1 = 有失败）
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

// ===== 真机详情页夹具（节选：只保留本链路用到的结构，逐字对齐真实 DOM）=====
const JD_BODY = `【公司介绍】
关于 UniPat
UniPat.ai 由来自头部大模型公司的研究员联合创立，获美元 VC 投资。我们与全球的模型厂商深度合作，通过专家知识数据与强化学习环境加速通用人工智能的到来。成立以来，业务连续每季度翻倍增长。

【为什么现在加入】
• 与一线研究员并肩工作，直接参与前沿模型的训练与评测，站在 AI 技术演进的前排
• 深度参与数据方法论研究，以共同作者身份发表顶会论文

【你将负责】
• 搭建专家数据平台，让团队可以更高效地组织和追踪数据生产全流程
• 搭建数据管线与任务系统：实现任务自动分发、进度追踪、质检流程，让专家团队的协作有序运转
• 搭建标注工具：为不同场景（文本、代码、多模态等）开发专用的标注界面，让领域专家能高效地把专业知识"教"给模型

【我们期望你】
• 后端熟悉 Python / Go / Java 至少一种，前端能独立交付可用的产品界面
• 能自己判断优先级，适应快节奏和资源约束环境
• 把 AI coding 工具（Claude Code / Cursor 等）当作日常工作流的一部分
【加分项】
有开源贡献或技术博客
计算机竞赛ACM-ICPC经历优先

截止日期：2027年07月16日
招聘人数：1人`;

const FIXTURE = `<!DOCTYPE html><html lang="zh-CN"><head>
<title>【北京 【红杉成员企业】全栈开发实习生招聘】-红杉中国北京招聘信息-猎聘</title>
</head><body>
<header id="framework-pc-header-container"><nav class="header-content-box"><a href="https://www.liepin.com" title="猎聘">猎聘</a></nav></header>
<section class="job-apply-container">
    <div class="job-apply-content">
        <div class="name-box">
            <span class="name ellipsis-2"><span class="job-title ellipsis-2">【红杉成员企业】全栈开发实习生</span></span>
            <span class="provider">提供转正</span>
            <span class="salary">500元/天</span>
        </div>
        <div class="title-tooltip"></div>
        <div class="job-properties">
            <span>北京-海淀区</span>
            <span class="split"></span>
            <span>实习</span>
            <span class="split"></span>
            <span>5天/周</span>
            <span class="split"></span>
            <span>3个月</span>
            <span class="split"></span>
            <span>本科</span>
            <span class="split"></span>
            <span>学生可投</span>
            <span class="split"></span>
            <span class="recruit-cnt">招1人</span>
            <span class="split"></span>
            <span class="update-time">7月16日更新</span>
        </div>
    </div>
</section>

<main><content>
    <section class="recruiter-container">
        <div class="content">
            <div class="name-box">
                <span class="name">王女士</span>
                <span class="online off">16分钟前在线</span>
                <span class="certification">已认证</span>
            </div>
            <div class="title-box">
                <span>HRM</span>
                <span>
                    <a href="https://www.liepin.com/company/9114275/" target="_blank"> · 红杉中国</a>
                </span>
            </div>
        </div>
    </section>
    <!-- 职位介绍 -->
    <section class="job-intro-container">
        <dl class="paragraph">
            <dt>职位介绍</dt>
            <dd data-selector="job-intro-content">${JD_BODY}</dd>
        </dl>
    </section>
    <!-- 公司介绍 -->
    <section class="company-intro-container" data-selector="company-intro-container">
        <h2>公司简介</h2>
        <div class="paragraph-box">
            <div class="inner ellipsis-3">红杉中国是专注于投资科技、医疗健康、消费三大领域的私募股权投资机构。</div>
            <a class="see-all" data-selector="see-all" href="javascript:;">查看全部</a>
        </div>
    </section>
</content></main>

<!-- 猜你喜欢（SEO 卡片：有 job-detail-header-box / job-title-box，是解析误命中的高风险区） -->
<section class="love-job-container"><h2>猜你喜欢</h2>
  <div class="job-list" data-selector="love-job-list">
    <div class="job-list-item"><div class="job-card-pc-container seo-job-card-action-box">
      <div class="job-card-left-box"><div class="job-detail-box">
        <a data-nick="job-detail-job-info" href="https://www.liepin.com/a/80357947.shtml" data-jobid="80357947">
          <div class="job-detail-header-box">
            <div class="job-title-box"><div title=" Agent研发" class="ellipsis-1"> Agent研发</div>
              <div class="job-dq-box"><span class="dq-bracket">【</span><span class="ellipsis-1">北京</span><span class="dq-bracket">】</span></div>
            </div>
            <span class="job-salary">25-35k·15薪</span>
          </div>
        </a>
      </div></div>
    </div></div>
  </div>
</section>
</body></html>`;

// 列表卡文本（旧实现冒充 JD 的形态，用于断言「不再是它」）
const CARD_TEXT = '【红杉成员企业】全栈开发实习生 【 北京-海淀区 】 500元/天 实习 学生可投 本科 红杉中国 基金/证券/期货100-499人 王女士·HRM 14分钟前在线';

// ===== ④ JD 截止日期判定断言（jobExpiry.ts）=====
// 判定基准日固定为 2026-10-01（用户报告日），避免回归随真实时间漂移而失真。
// 加载方式与 score-regression.mjs 同口径：用项目内 esbuild 把 TS 源打成临时 CJS 再 require，
// 不引入任何新依赖、不改 package.json。
const NOW_1001 = new Date(2026, 9, 1, 15, 0, 0).getTime();
async function expiryChecks() {
  const { build } = await import('esbuild');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'bossclaw-expiry-'));
  const outfile = join(dir, 'bundle.cjs');
  let E;
  try {
    await build({
      stdin: {
        contents: "export * from './src/lib/bossclaw/jobExpiry.ts';",
        resolveDir: root,
        sourcefile: 'liepin-expiry-entry.ts',
        loader: 'ts',
      },
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'node18',
      outfile,
      logLevel: 'silent',
    });
    E = require(outfile);
  } catch (err) {
    failures.push(`jobExpiry 模块打包失败：${err?.message || err}`);
    return;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  const { parseJdDeadline, checkJobExpiry, isExpiryFilterEnabled, PLATFORM_EXPIRY_DEFAULT, startOfToday } = E;
  const ymd = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // ① 真机形态（用户报告的那一行）：解析出正确日期 + 判定为「未过期」
  const d0 = parseJdDeadline('截止日期：2027年07月16日', NOW_1001);
  ok('解析「截止日期：2027年07月16日」', Boolean(d0), JSON.stringify(d0));
  eq('日期拆解为 2027-07-16', d0 ? ymd(d0.ts) : '', '2027-07-16');
  eq('未来截止日 → 不算过期', d0?.expired, false);

  // ② 已过期（同一书写形态，但截止日早于今天）
  const dPast = parseJdDeadline('截止日期：2026年07月16日', NOW_1001);
  eq('过去截止日 → 已过期', dPast?.expired, true);
  eq('过期岗位的拦截原因带日期', checkJobExpiry({ description: '截止日期：2026年07月16日' }, NOW_1001).reason,
    '岗位 JD 标注截止日期 2026-07-16，已过期');

  // ③ 边界：截止日「当天」仍有效，次日才过期
  eq('截止日 = 今天 → 仍有效', parseJdDeadline('截止日期：2026年10月01日', NOW_1001)?.expired, false);
  eq('截止日 = 昨天 → 已过期', parseJdDeadline('截止日期：2026年09月30日', NOW_1001)?.expired, true);

  // ④ 其它书写形态
  eq('「截止时间」+ 连字符', parseJdDeadline('截止时间：2027-07-16', NOW_1001)?.expired, false);
  eq('「投递截止日期」+ 斜杠', parseJdDeadline('投递截止日期：2026/07/16', NOW_1001)?.expired, true);
  eq('「报名截止」+ 点号', parseJdDeadline('报名截止：2026.07.16', NOW_1001)?.expired, true);
  eq('「有效期至」', parseJdDeadline('有效期至 2026年12月31日', NOW_1001)?.expired, false);

  // ⑤ 护栏：不写截止日期 / 非日期语义 → 一律不判定（防止误杀绝大多数岗位）
  eq('无截止日期标签 → null', parseJdDeadline('岗位职责：负责前后端开发，要求熟悉 Python', NOW_1001), null);
  eq('「长期有效」→ null', parseJdDeadline('截止日期：长期有效', NOW_1001), null);
  eq('「招满即止」→ null', parseJdDeadline('报名截止：招满即止', NOW_1001), null);
  eq('年限越界（工龄噪声）→ null', parseJdDeadline('截止日期：3年', NOW_1001), null);
  eq('非法日期（2 月 30 日）→ null', parseJdDeadline('截止日期：2027年02月30日', NOW_1001), null);
  eq('空文本 → null', parseJdDeadline('', NOW_1001), null);

  // ⑥ 完整 JD（真机夹具 JD_BODY）端到端：夹具截止日是 2027-07-16（未来）→ 放行
  const full = parseJdDeadline(JD_BODY, NOW_1001);
  eq('真机夹具 JD 可解析出截止日期', full ? ymd(full.ts) : '', '2027-07-16');
  eq('真机夹具 JD（2027-07-16）在 2026-10-01 未过期', full?.expired, false);
  eq('同一夹具在 2027-08-01 判定为已过期', parseJdDeadline(JD_BODY, new Date(2027, 7, 1).getTime())?.expired, true);

  // ⑦ 岗位对象口径：title / description / cardText 三处任一带截止日期都能命中
  eq('从 cardText 命中', checkJobExpiry({ cardText: '截止日期：2026年01月01日' }, NOW_1001).expired, true);
  eq('从 title 命中', checkJobExpiry({ title: '实习（截止日期：2026年01月01日）' }, NOW_1001).expired, true);
  eq('三字段都无 → 不拦截', checkJobExpiry({ title: '后端开发', description: '负责服务端开发' }, NOW_1001).expired, false);

  // ⑧ 开关与平台默认：仅猎聘默认开启
  eq('猎聘默认开启', PLATFORM_EXPIRY_DEFAULT.liepin, true);
  eq('BOSS 默认关闭', PLATFORM_EXPIRY_DEFAULT.boss, false);
  eq('显式配置优先于默认', isExpiryFilterEnabled({ excludeExpiredJobs: false }, 'liepin', true), false);
  eq('配置缺失回落默认（猎聘）', isExpiryFilterEnabled({}, 'liepin', PLATFORM_EXPIRY_DEFAULT.liepin), true);
  eq('配置缺失回落默认（BOSS）', isExpiryFilterEnabled({}, 'boss', PLATFORM_EXPIRY_DEFAULT.boss), false);

  // ⑨ startOfToday 必须归零时分秒（判定基准一致性）
  const t0 = new Date(startOfToday(NOW_1001));
  ok('startOfToday 归零到当日 0 点', t0.getHours() === 0 && t0.getMinutes() === 0 && t0.getSeconds() === 0, String(t0));
}


try {
  const A = require(`${root.replace(/\\/g, '/')}/electron/preload/platform-adapters.cjs`);
  const { liepinJobDetailUrl, parseLiepinJobDetailHtml, PLATFORM_DETAIL_API_FILL } = A;

  // ---------- ① 岗位号 → 详情页 URL ----------
  eq('新版 /job/<id>.shtml', liepinJobDetailUrl('https://www.liepin.com/job/1984191109.shtml?pgRef=x'), 'https://www.liepin.com/job/1984191109.shtml');
  eq('SEO /a/<id>.shtml（取末段数字）', liepinJobDetailUrl('https://www.liepin.com/a/80357947.shtml?pgRef=y'), 'https://www.liepin.com/job/80357947.shtml');
  eq('裸岗位号', liepinJobDetailUrl('1984191109'), 'https://www.liepin.com/job/1984191109.shtml');
  eq('哈希兜底身份 → 不拼 URL', liepinJobDetailUrl('f1abc2x'), '');
  eq('搜索页 URL → 不拼 URL', liepinJobDetailUrl('https://www.liepin.com/zhaopin/?key=x'), '');
  eq('空值', liepinJobDetailUrl(''), '');

  // ---------- ② 详情页 HTML → 补齐字段 ----------
  const r = parseLiepinJobDetailHtml(FIXTURE);
  ok('详情页可解析', Boolean(r));
  const jd = r?.description || '';

  // JD 保真（最关键的三条）
  ok('JD 非空且为完整正文（> 400 字）', jd.length > 400, `实际长度 ${jd.length}`);
  ok('JD 保留分段标题（保真红线）', jd.includes('【你将负责】') && jd.includes('【我们期望你】') && jd.includes('【加分项】'), jd.slice(0, 100));
  ok('JD 保留换行（未被压成一行）', jd.split('\n').filter(Boolean).length >= 10, `行数 ${jd.split('\n').length}`);
  ok('JD 已剥净 HTML 标签', !/[<>]/.test(jd), jd.slice(0, 120));
  ok('JD 不是「整卡文本」冒充（用户报告的 bug 形态）',
    !/^【红杉成员企业】全栈开发实习生\s+【/.test(jd) && !jd.includes('14分钟前在线'), jd.slice(0, 120));
  ok('JD 未混入「猜你喜欢」推荐岗位（job-detail-header-box 高风险区）',
    !jd.includes('Agent研发') && !jd.includes('25-35k'), jd.slice(-160));

  // 详情字段
  eq('标题', r?.title, '【红杉成员企业】全栈开发实习生');
  eq('薪资（原样，不换算）', r?.salary, '500元/天');
  eq('地点（属性区首个 span）', r?.location, '北京-海淀区');
  eq('公司（HR 行链接，剥掉前导 ·）', r?.company, '红杉中国');
  eq('HR 姓名', r?.recruiterName, '王女士');
  eq('HR 职位', r?.recruiterTitle, 'HRM');
  eq('标签（保留实习/学历口径，剔除「招N人」「N月N日更新」噪声）', r?.welfare, ['实习', '5天/周', '3个月', '本科', '学生可投']);

  // ---------- ③ 异常载荷 → null（保持卡片兜底）----------
  eq('null', parseLiepinJobDetailHtml(null), null);
  eq('空串', parseLiepinJobDetailHtml(''), null);
  eq('过短响应（错误页）', parseLiepinJobDetailHtml('<html></html>'), null);
  eq('无 JD 容器（登录墙 / 改版）', parseLiepinJobDetailHtml(`<!DOCTYPE html><html><body>${'<div class="x">登录后查看</div>'.repeat(60)}</body></html>`), null);
  eq('JD 容器为空（岗位没写 JD）', parseLiepinJobDetailHtml(`<!DOCTYPE html><html><body><dd data-selector="job-intro-content">  </dd>${'<!--pad-->'.repeat(80)}</body></html>`), null);

  // ---------- 能力表（防回退：猎聘必须声明走补齐通道）----------
  eq('补齐能力表含智联 + 猎聘', PLATFORM_DETAIL_API_FILL, { zhaopin: true, liepin: true });
  ok('猎聘详情页 URL 走 liepin.com 同源', liepinJobDetailUrl('1984191109').startsWith('https://www.liepin.com/job/'), liepinJobDetailUrl('1984191109'));

  // ---------- ④ JD「截止日期」判定（jobExpiry.ts 唯一权威）----------
  // 触发场景（用户 2026-10-01 报告）：猎聘 JD 末尾「截止日期：2027年07月16日」，
  // 今天是 2026-10-01 → 该岗位尚未过期，不得被误拦；而 2026 年及更早的截止日期必须拦下。
  await expiryChecks();
} catch (err) {
  failures.push(`导入/执行失败：${err?.message || err}`);
}

if (failures.length) {
  console.error(`\n[猎聘 JD 补齐回归] 失败 ${failures.length} 项 / 通过 ${pass} 项\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exitCode = 1;
} else {
  console.log(`[猎聘 JD 补齐回归] 全部通过：${pass} 项断言`);
}
console.log(`（参考：旧实现入库的「岗位」= ${CARD_TEXT.slice(0, 46)}…）`);
