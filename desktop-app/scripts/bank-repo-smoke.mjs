// 题库仓储冒烟（主进程文件读写，用 electron 桩跑在 Node 下）
//
// 覆盖：内置库登记/读取、用户库增删改、导入、启停、索引缓存读写与删除、目录占用。
// 用法：node scripts/bank-repo-smoke.mjs
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const home = mkdtempSync(join(tmpdir(), 'bank-repo-'));

// electron 桩：只需要 app.getPath / app.getAppPath
const Module = require('node:module');
const orig = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') {
    return {
      app: {
        getPath: () => join(home, 'userData'),
        getAppPath: () => root,
      },
    };
  }
  return orig.call(this, req, ...rest);
};

const repo = require(join(root, 'electron', 'mockInterviewBankRepo.cjs'));

let failures = 0;
const log = [];
function check(name, fn) {
  try {
    fn();
    log.push(`  ok   ${name}`);
  } catch (e) {
    failures += 1;
    log.push(`  FAIL ${name}\n       ${e.message}`);
  }
}
function ok(cond, label) {
  if (!cond) throw new Error(label || '断言失败');
}
function eq(a, b, label) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${label || '值'} 不符：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
  }
}

const t0 = Date.now();
const list = repo.list();
const builtin = list.banks.find((b) => b.id === repo.BUILTIN_ID);
check('首次 list 自动登记内置库', () => {
  ok(builtin, '应有内置库');
  ok(builtin.count > 12000, `内置库条数 ${builtin.count}`);
  eq(builtin.enabled, true, '默认启用');
  eq(builtin.editable, false, '内置库不可编辑');
});

check('读取内置库（含 bankId）', () => {
  const t = Date.now();
  const r = repo.read(repo.BUILTIN_ID);
  ok(r.ok, r.error);
  ok(r.questions.length > 12000, `条数 ${r.questions.length}`);
  ok(r.questions[0].bankId === repo.BUILTIN_ID, '应补上 bankId');
  log.push(`  info 读取内置库 ${r.questions.length} 条 · ${Date.now() - t}ms`);
});

check('内置库写入被拒绝', () => {
  let rejected = false;
  try {
    repo.addQuestion(repo.BUILTIN_ID, { text: '这是一道试图写进内置库的题' });
  } catch (e) {
    rejected = /只读/.test(e.message);
  }
  ok(rejected, '应拒绝写入内置库');
});

const created = repo.createBank('我的面经');
check('新建用户题库', () => {
  ok(created.ok, created.error);
  eq(created.bank.count, 0, '初始条数');
  eq(created.bank.editable, true, '可编辑');
});

check('新增 / 修改 / 删除题目', () => {
  const bankId = created.bank.id;
  const a = repo.addQuestion(bankId, {
    text: '你们团队怎么做需求评审？',
    directions: ['product'],
    difficulty: 'standard',
    category: 'behavior',
    keyPoints: ['评审流程', '参与角色', '结论如何落地'],
  });
  ok(a.ok, a.error);
  eq(a.count, 1, '条数');
  const b = repo.addQuestion(bankId, { text: '第二个问题：介绍一下你最近做的一个项目', answer: '略' });
  eq(b.count, 2, '条数');
  const u = repo.updateQuestion(bankId, a.question.id, { text: '你们团队怎么做需求评审和排期？' });
  ok(u.ok, u.error);
  ok(/排期/.test(u.question.text), '应更新题干');
  const d = repo.deleteQuestion(bankId, b.question.id);
  eq(d.count, 1, '删除后条数');
});

check('批量导入（append）与条数同步', () => {
  const bankId = created.bank.id;
  const r = repo.importQuestions(
    bankId,
    [
      { text: '导入题一：什么情况下你会推翻自己的方案？', keyPoints: ['判断依据'] },
      { text: '导入题二：怎么和跨团队对齐目标？' },
    ],
    { mode: 'append' },
  );
  ok(r.ok, r.error);
  eq(r.count, 3, '导入后总条数');
  const after = repo.list().banks.find((b) => b.id === bankId);
  eq(after.count, 3, '注册表条数应同步');
});

check('覆盖导入（replace）', () => {
  const bankId = created.bank.id;
  const r = repo.importQuestions(bankId, [{ text: '覆盖后只剩这一道题，用来验证替换语义' }], { mode: 'replace' });
  ok(r.ok, r.error);
  eq(r.count, 1, '覆盖后条数');
});

check('启停题库', () => {
  const r = repo.setEnabled(created.bank.id, false);
  ok(r.ok, r.error);
  eq(repo.list().banks.find((b) => b.id === created.bank.id).enabled, false, '停用状态');
  repo.setEnabled(created.bank.id, true);
});

check('索引缓存写 / 读 / 删', () => {
  const w = repo.writeIndexCache(JSON.stringify({ v: 1, hello: 'world' }));
  ok(w.ok, w.error);
  const r = repo.readIndexCache();
  ok(r.ok && /world/.test(r.data), '应读回缓存');
  const c = repo.clearIndexCache();
  ok(c.ok, '删除缓存');
  ok(!existsSync(repo._paths.cachePath()), '缓存文件应不存在');
});

check('目录占用包含用户题库', () => {
  const u = repo.usage();
  ok(u.ok, u.error);
  ok(u.bytes > 0, `占用 ${u.bytes}`);
});

check('删除用户题库后注册表不残留', () => {
  const r = repo.deleteBank(created.bank.id);
  ok(r.ok, r.error);
  ok(!repo.list().banks.some((b) => b.id === created.bank.id), '应已移除');
});

check('恢复内置库（幂等）', () => {
  const a = repo.restoreBuiltin();
  ok(a.ok, a.error);
  const b = repo.restoreBuiltin();
  ok(b.ok, b.error);
  eq(repo.list().banks.filter((x) => x.type === 'builtin').length, 1, '只应有一个内置库');
});

console.log(log.join('\n'));
console.log(failures ? `\n${failures} 项失败` : `\n全部 ${log.filter((x) => x.startsWith('  ok')).length} 项通过`);
console.log(`耗时 ${Date.now() - t0}ms`);
rmSync(home, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
