// 工作台岗位 → 定制简历：离线验证岗位范围、信息清洗和跨页请求，不调用 AI 或招聘平台。
// 用法：node scripts/tailor-job-regression.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = mkdtempSync(join(tmpdir(), 'bossclaw-tailor-test-'));
try {
  const outfile = join(temporary, 'bundle.cjs');
  await build({
    stdin: {
      contents: "export * from './src/lib/bossclaw/tailorJob'; export * from './src/store/useAppStore';",
      resolveDir: root,
      loader: 'ts',
    },
    tsconfig: join(root, 'tsconfig.json'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile,
    logLevel: 'silent',
  });
  const { listTailorJobs, buildTailorJobInput, tailorJobLabel } = createRequire(import.meta.url)(outfile);
  const item = (id, status, createdAt, extra = {}) => ({
    id, status, createdAt, deliveryGreeting: '', job: { title: '前端开发', company: '示例公司' }, ...extra,
  });
  const jobs = [
    item('sent', 'sent', 100, { sentAt: 1000 }),
    item('pending', 'pending', 300),
    item('approved', 'approved', 100, { approvedAt: 400 }),
    item('queue', 'approved_queue', 200),
    item('failed', 'failed', 150),
    item('opened', 'opened', 120),
    item('ignored', 'ignored', 500),
    item('skipped', 'skipped', 600),
  ];
  const originalOrder = jobs.map((p) => p.id);
  assert.deepEqual(listTailorJobs(jobs).map((p) => p.id), ['approved', 'pending', 'queue', 'failed', 'opened', 'sent']);
  assert.deepEqual(jobs.map((p) => p.id), originalOrder, '筛选不能改动工作台原数组');
  assert.ok(listTailorJobs(jobs, 'ignored').some((p) => p.id === 'ignored'), '显式选中的已忽略岗位仍可使用');
  assert.match(tailorJobLabel(jobs[1]), /前端开发 · 示例公司（待确认）/);
  assert.match(tailorJobLabel(jobs[0]), /已投递/);

  const sourceJob = {
    title: '前端开发 10-20K', company: '示例公司', salary: '\uE032\uE031-\uE033\uE031K',
    location: '上海', welfare: ['双休', '五险一金'], platform: 'boss', jobId: 'job-1',
    description: '公司：示例公司\n岗位职责：使用 React 开发页面。\n任职要求：熟悉 TypeScript。\n热门职位 无关推荐',
    cardText: '不能代替完整 JD 的列表摘要',
  };
  const input = buildTailorJobInput(sourceJob);
  assert.equal(input.jobTitle, '前端开发');
  assert.equal(input.source, 'description');
  assert.ok(input.jobDesc.includes('React') && input.jobDesc.includes('TypeScript'));
  assert.ok(!input.jobDesc.includes('热门职位') && !input.jobDesc.includes('无关推荐'));
  assert.ok(!input.jobDesc.includes('列表摘要'));
  assert.equal((input.jobDesc.match(/公司：示例公司/g) || []).length, 1, '不重复添加公司标签');
  assert.ok(input.jobDesc.includes('薪资：10-20K') && input.jobDesc.includes('地点：上海'));
  assert.ok(input.jobDesc.includes('福利：双休、五险一金'));
  assert.equal(input.job.company, '示例公司');
  assert.equal(input.job.salary, '10-20K');
  assert.equal(input.job.location, '上海');
  assert.equal(input.job.jobId, 'job-1');
  assert.equal(input.job.description, input.jobDesc);
  assert.equal(sourceJob.title, '前端开发 10-20K', '转换不能修改工作台岗位');

  const card = buildTailorJobInput({ title: '开发实习', cardText: '熟悉 Vue 收藏 立即沟通 热门城市 推荐列表' });
  assert.equal(card.source, 'card');
  assert.equal(card.jobDesc, '熟悉 Vue');
  const metadata = buildTailorJobInput({ title: '开发实习', company: '示例公司', location: '深圳' });
  assert.equal(metadata.source, 'metadata');
  assert.equal(metadata.jobDesc, '公司：示例公司\n地点：深圳');
  const empty = buildTailorJobInput({});
  assert.equal(empty.jobTitle, '');
  assert.equal(empty.jobDesc, '');

  // 显式选中的岗位始终可选：已忽略/已跳过的岗位不进入默认列表，但被显式勾选后仍可用于定制。
  assert.ok(listTailorJobs(jobs, ['ignored']).some((p) => p.id === 'ignored'), '显式选中已忽略岗位');
  assert.ok(listTailorJobs(jobs, ['skipped']).some((p) => p.id === 'skipped'), '显式选中已跳过岗位');
  assert.equal(listTailorJobs(jobs, []).some((p) => p.id === 'ignored'), false, '空选择回到默认列表');
  assert.equal(listTailorJobs(jobs).some((p) => p.id === 'skipped'), false, '默认不含已跳过');
  assert.equal(listTailorJobs(jobs, ['ignored']).length, listTailorJobs(jobs).length + 1, '默认项与显式选中项合并');
  console.log('PASS: 岗位范围、完整 JD/摘要/基本信息、元数据保留与显式选择');
} finally {
  assert.ok(resolve(temporary).startsWith(resolve(tmpdir()) + sep));
  rmSync(temporary, { recursive: true, force: true });
}
