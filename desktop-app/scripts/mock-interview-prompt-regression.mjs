// 模拟面试「提示词契约」回归（零新增依赖，esbuild 打包 TS 后离线执行）
//
// 为什么需要它：engine 里的六段 SYSTEM 提示词带着产品的硬口径——
//   · 只问一个问题 / 题干 60 字以内（否则模型回到「请介绍背景、职责和结果」的三连问）；
//   · 只给档位不给分数（否则模型自报总分，本地加权就白做了）；
//   · 不得引用面试官的追问当 evidence（否则用户会被莫名压分）；
//   · 反问的四条禁区（否则模拟面试官开始编造公司内部信息）。
// 这些约束删掉一句，typecheck 和构建都不会报错，只会在线上悄悄退化。
// 本脚本对提示词做关键词断言：改提示词时如果误删约束，这里直接红。
//
// 用法：node scripts/mock-interview-prompt-regression.mjs   （EXIT 0 = 全通过，1 = 有失败）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const outDir = mkdtempSync(join(tmpdir(), 'mi-prompt-'));
const outFile = join(outDir, 'bundle.cjs');

let failures = 0;
const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(`  ok   ${name}`);
  } catch (e) {
    failures += 1;
    results.push(`  FAIL ${name}\n       ${e.message}`);
  }
}
function has(text, part, label) {
  if (!String(text).includes(part)) throw new Error(`${label || '提示词'} 缺少约束：${JSON.stringify(part)}`);
}
function hasNot(text, part, label) {
  if (String(text).includes(part)) throw new Error(`${label || '提示词'} 不应包含：${JSON.stringify(part)}`);
}
function ok(cond, label) {
  if (!cond) throw new Error(label || '断言失败');
}

// 提示词是纯字符串，模型调用用桩替换，不联网
const stubPlugin = {
  name: 'stub-ai',
  setup(b) {
    b.onResolve({ filter: /^\.\/llm$/ }, () => ({ path: 'stub-llm', namespace: 'stub' }));
    b.onResolve({ filter: /^\.\/skills$/ }, () => ({ path: 'stub-skills', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
      if (args.path === 'stub-skills') {
        return { loader: 'js', contents: 'export const skillInstructionsFor = async () => "";' };
      }
      return {
        loader: 'js',
        contents: [
          'export const callModel = async () => { throw new Error("stub: 提示词回归不调用 AI"); };',
          'export const cachedCallModel = callModel;',
          'export const extractJson = (x) => x;',
        ].join('\n'),
      };
    });
  },
};

try {
  await build({
    entryPoints: [join(root, 'src/lib/bossclaw/mockInterviewEngine.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: outFile,
    logLevel: 'silent',
    plugins: [stubPlugin],
  });
  const E = require(outFile);
  const P = E.MOCK_PROMPTS;

  check('提示词表完整（六段都导出）', () => {
    for (const key of ['phase1', 'phase2', 'advance', 'report', 'reverse', 'rewrite']) {
      ok(typeof P[key] === 'string' && P[key].length > 200, `${key} 提示词缺失或过短`);
    }
  });

  // ===== 阶段一 =====
  check('阶段一：一道题只问一个问题 + 字数上限 + 由浅入深', () => {
    has(P.phase1, '一道题只问一个问题');
    has(P.phase1, '60 字以内');
    has(P.phase1, '由浅入深');
  });
  check('阶段一：不得针对简历细节 / 不得泄露考察点 / 不得问个人信息', () => {
    has(P.phase1, '不要针对简历里的具体项目细节');
    has(P.phase1, '透露考察点');
    has(P.phase1, '年龄、婚育、户籍、健康、政治面貌');
  });
  check('阶段一：保留自检清单', () => {
    has(P.phase1, '逐题自检');
    has(P.phase1, '只有一个问句');
  });
  check('阶段一：输出契约字段没有丢', () => {
    for (const f of ['jdRef', 'focus', 'rubric', 'probeDirections', 'sourceQuestionId']) {
      has(P.phase1, f);
    }
  });

  // ===== 阶段二 =====
  check('阶段二：接住原话 + 只问一个问题 + 完整回答改问边界', () => {
    has(P.phase2, '接住对方说过的一个具体词或数字');
    has(P.phase2, '一道题只问一个问题');
    has(P.phase2, '改问边界或迁移');
  });
  check('阶段二：深挖优先级四级顺序完整且顺序正确', () => {
    const i1 = P.phase2.indexOf('指标口径与定义');
    const i2 = P.phase2.indexOf('方法与工具细节');
    const i3 = P.phase2.indexOf('业务价值与影响');
    const i4 = P.phase2.indexOf('量化结果的真实性与推导过程');
    ok(i1 >= 0 && i2 > i1 && i3 > i2 && i4 > i3, '四级优先级顺序被改动');
  });
  check('阶段二：不得引入简历与回答里没有的事实', () => {
    has(P.phase2, '不得引入简历与回答里没有的公司、项目、数字');
  });

  // ===== 追问裁决 =====
  check('追问：六态证据定义齐全', () => {
    for (const s of ['insufficient', 'vague', 'partial', 'solid', 'strong', 'conflict']) has(P.advance, s);
  });
  check('追问：五种意图齐全且与证据状态映射', () => {
    for (const s of ['clarify', 'verify', 'deepen', 'challenge', 'transfer']) has(P.advance, s);
    has(P.advance, '压力');
  });
  check('追问：只问一个点 + 必须接住具体词 + 不许空题', () => {
    has(P.advance, '只问一个最关键的点');
    has(P.advance, '接住对方原话里的**一个具体词或数字**');
    has(P.advance, '能具体说说吗');
  });
  check('追问：reasoning 必须在 evidenceState 之前', () => {
    has(P.advance, 'reasoning 必须写在 evidenceState 之前');
  });

  // ===== 评分 =====
  check('评分：明确不给分数、不给总分、不给档位', () => {
    has(P.report, '不要给分数');
    has(P.report, '也不要给总分或档位');
  });
  check('评分：四档语义与档内 pos 都在', () => {
    for (const s of ['4 强', '3 扎实', '2 部分', '1 不足', 'pos']) has(P.report, s);
  });
  check('评分：evidence 必须逐字摘录，且不得引用面试官追问', () => {
    has(P.report, '逐字摘录');
    has(P.report, '不要拿面试官追问里的措辞当 evidence');
  });
  check('评分：长度不是优点 / 空答落在 1 档 / 不许全标 na', () => {
    has(P.report, '回答长不等于答得好');
    has(P.report, '空答、跳过、答非所问同样落在 1 档');
    has(P.report, '不要为了省事把所有维度标 na');
  });
  check('评分：missedPoints 不许把「更高级的做法」算漏答', () => {
    has(P.report, '不许把「更高级的做法」「别的公司怎么做的」算成漏答');
  });
  check('评分：有题库要点时以题库要点为准', () => {
    has(P.report, '题目若给了「题库要点」，就以这些要点为准逐条判');
  });
  check('评分：禁评人格情绪、禁预测录用概率', () => {
    has(P.report, '不得评价人格、情绪、诚实、健康、外貌');
    has(P.report, '不得预测录用概率');
  });
  check('评分：questionId 必须原样使用', () => {
    has(P.report, 'questionId 必须原样使用输入中的 id');
  });

  // ===== 反问 =====
  check('反问：四条信息白名单与五类禁区都在', () => {
    has(P.reverse, 'JD 原文、岗位名、公司名、公开行业常识');
    for (const s of ['组织架构', 'HC', '薪资', '团队规模', '内部技术选型']) has(P.reverse, s);
  });
  check('反问：越界时走统一话术且不入存档', () => {
    has(P.reverse, 'refused 设为 true');
    has(P.reverse, '这个我在这儿没法替公司回答');
  });
  check('反问：点评只评提问质量', () => {
    has(P.reverse, '只评价候选人这个提问好不好');
  });

  // ===== 改写 =====
  check('改写：不得新增数字 / 只用已有事实 / 不注水', () => {
    has(P.rewrite, '不得新增任何数字');
    has(P.rewrite, '只能使用「用户原答」与「简历原文」里已存在的事实');
    has(P.rewrite, '不要注水');
  });

  // ===== 本地规则 → 追问意图（确定性映射，不依赖模型） =====
  check('规则意图映射：数字冲突→核对，过短/无个人贡献→澄清，其余→深挖', () => {
    ok(E.intentForRule('数字冲突') === 'verify', '数字冲突应映射核对');
    ok(E.intentForRule('回答过短') === 'clarify', '回答过短应映射澄清');
    ok(E.intentForRule('无个人贡献') === 'clarify', '无个人贡献应映射澄清');
    ok(E.intentForRule('无量化结果') === 'deepen', '无量化结果应映射深挖');
    ok(E.intentForRule('情境缺失') === 'deepen', '情境缺失应映射深挖');
  });
} catch (e) {
  failures += 1;
  results.push(`  FAIL 构建/加载失败\n       ${e.message}`);
} finally {
  try { rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(results.join('\n'));
if (failures) {
  console.error(`\n模拟面试提示词回归：${failures} 项失败`);
  process.exit(1);
}
console.log(`\n模拟面试提示词回归：全部通过（${results.length} 项）`);
