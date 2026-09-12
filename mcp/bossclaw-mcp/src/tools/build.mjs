// src/tools/build.mjs —— 构建与验证工具组
// ---------------------------------------------------------------------------
// 对齐项目约定：一律直接 `node node_modules/<pkg>/bin.js`，不用 npx / .bin
// （历史上 .bin 曾被清理，npx 不可靠）。
import path from 'node:path';
import fsp from 'node:fs/promises';
import { PATHS, NODE_BIN, DESKTOP_DIR, MCP_DIR, run, ok, fail, humanBytes, statSafe, readJsonSafe, truncate, walkFiles } from '../context.mjs';
import { obj, str, num, bool, enumStr, READ_ONLY, WRITE_LOCAL } from '../schema.mjs';
import { listJobs, startJob, jobOutput, killJob } from '../jobs.mjs';

/** 从 tsc 输出里抽取结构化错误（TS 错误形如 src/a.ts(12,5): error TS1234: msg） */
function parseTsErrors(text) {
  const out = [];
  const re = /^(.*?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/gm;
  let m;
  while ((m = re.exec(text))) {
    out.push({ file: m[1], line: Number(m[2]), col: Number(m[3]), severity: m[4], code: m[5], message: m[6] });
  }
  return out;
}

function parseViteErrors(text) {
  const out = [];
  const re = /^\[?(vite[^\]]*|rollup)\s*(error|Error)\s*\]?[:\s]*(.*)$/gim;
  let m;
  while ((m = re.exec(text))) out.push({ source: m[1], message: m[3] || m[2] });
  return out.slice(0, 50);
}

async function distSummary() {
  const info = await statSafe(PATHS.distDir);
  if (!info.exists) return { exists: false, files: [], totalBytes: 0 };
  const files = [];
  let totalBytes = 0;
  for await (const f of walkFiles(PATHS.distDir, { maxFiles: 5000, ignores: new Set() })) {
    const st = await statSafe(f);
    if (!st.exists) continue;
    totalBytes += st.size;
    files.push({ rel: path.relative(DESKTOP_DIR, f).split(path.sep).join('/'), size: st.size, sizeText: humanBytes(st.size), mtime: st.mtime });
  }
  files.sort((a, b) => b.size - a.size);
  return { exists: true, mtime: info.mtime, totalBytes, totalText: humanBytes(totalBytes), fileCount: files.length, files: files.slice(0, 20) };
}

async function runTypecheck(timeoutMs) {
  return run(NODE_BIN, [PATHS.tscBin, '-b', '--pretty', 'false'], { cwd: DESKTOP_DIR, timeoutMs });
}

async function runBuild(timeoutMs) {
  return run(NODE_BIN, [PATHS.viteBin, 'build'], { cwd: DESKTOP_DIR, timeoutMs });
}

/**
 * 清理 tsc 增量缓存。
 * 注意：缓存路径由各 tsconfig 的 tsBuildInfoFile 决定（本项目为
 * desktop-app/node_modules/.tmp/*.tsbuildinfo），不能硬编码到项目根目录，
 * 否则「force」形同虚设（曾因此漏检缓存导致的陈旧诊断）。
 */
async function clearTsBuildInfo() {
  const removed = [];
  const candidates = new Set();
  for (const cfg of ['tsconfig.json', 'tsconfig.node.json']) {
    const parsed = await readJsonSafe(path.join(DESKTOP_DIR, cfg));
    const rel = parsed.ok ? parsed.data?.compilerOptions?.tsBuildInfoFile : null;
    if (rel) candidates.add(path.resolve(DESKTOP_DIR, rel));
  }
  // 兜底：扫描 node_modules/.tmp 与项目根下所有 *.tsbuildinfo
  for (const dir of [path.join(DESKTOP_DIR, 'node_modules', '.tmp'), DESKTOP_DIR]) {
    for (const f of await fsp.readdir(dir).catch(() => [])) {
      if (f.endsWith('.tsbuildinfo')) candidates.add(path.join(dir, f));
    }
  }
  for (const file of candidates) {
    const st = await statSafe(file);
    if (!st.exists) continue;
    await fsp.rm(file, { force: true }).catch(() => {});
    if (!(await statSafe(file)).exists) removed.push(path.relative(DESKTOP_DIR, file).split(path.sep).join('/'));
  }
  return removed;
}

export const buildTools = [
  {
    name: 'bossclaw_typecheck',
    title: 'TypeScript 类型检查',
    description:
      '执行 tsc -b（增量构建 + 类型检查）。返回退出码、耗时与结构化 TS 错误列表。' +
      '若怀疑 tsbuildinfo 增量缓存导致漏报，可先用 force 参数删除缓存再跑。',
    annotations: READ_ONLY,
    inputSchema: obj({
      timeoutSec: num('超时秒数（默认 300）', { default: 300 }),
      force: bool('先清理 tsbuildinfo 增量缓存再检查（默认 false）', { default: false }),
    }),
    handler: async (args = {}) => {
      const timeoutMs = Math.min(Math.max(Number(args.timeoutSec) || 300, 10), 1800) * 1000;
      let cleared = [];
      if (args.force) {
        cleared = await clearTsBuildInfo();
        // 破增量缓存最稳妥的方式是 touch 一个源文件（用标准的 for await，避免依赖 Array.fromAsync 这种 Node 22+ API）
        let first = null;
        for await (const f of walkFiles(path.join(DESKTOP_DIR, 'src'), { maxFiles: 5 })) {
          first = f;
          break;
        }
        if (first) await fsp.utimes(first, new Date(), new Date()).catch(() => {});
      }
      const res = await runTypecheck(timeoutMs);
      const raw = `${res.stdout}\n${res.stderr}`;
      const errors = parseTsErrors(raw);
      const errCount = errors.filter((e) => e.severity === 'error').length;
      const lines = [
        `tsc -b：${res.ok ? '✅ 通过' : '❌ 未通过'}（退出码 ${res.code}${res.timedOut ? '，超时' : ''}，${res.durationMs}ms）`,
        cleared.length ? `已清理增量缓存：${cleared.join(', ')}` : '',
        errors.length ? `\n错误 ${errCount} 条：` : '',
        ...errors.slice(0, 80).map((e) => `  ${e.file}(${e.line},${e.col}) ${e.code}: ${e.message}`),
      ];
      if (!errors.length && !res.ok) lines.push('', truncate(raw.trim() || '(无输出)', 6000));
      const data = { ok: res.ok, code: res.code, durationMs: res.durationMs, errors, clearedTsBuildInfo: cleared };
      return res.ok ? ok(lines.filter(Boolean).join('\n'), data) : fail(lines.filter(Boolean).join('\n'), { ...data, stdout: truncate(raw, 8000) });
    },
  },

  {
    name: 'bossclaw_build',
    title: '生产构建（Vite）',
    description: '执行 vite build 生成 dist/。返回退出码、耗时、报错与产物摘要。构建是交付的一部分，不可跳过。',
    annotations: WRITE_LOCAL,
    inputSchema: obj({
      timeoutSec: num('超时秒数（默认 300）', { default: 300 }),
      background: bool('后台执行并立即返回 jobId（默认 false）', { default: false }),
    }),
    handler: async (args = {}) => {
      const timeoutMs = Math.min(Math.max(Number(args.timeoutSec) || 300, 10), 1800) * 1000;
      if (args.background) {
        const job = startJob({ label: 'vite build', cmd: NODE_BIN, args: [PATHS.viteBin, 'build'], cwd: DESKTOP_DIR });
        return ok(`已后台启动构建：${job.id}（用 bossclaw_job action=output 轮询）`, { jobId: job.id, cmd: job.cmd });
      }
      const res = await runBuild(timeoutMs);
      const raw = `${res.stdout}\n${res.stderr}`;
      const dist = await distSummary();
      const lines = [
        `vite build：${res.ok ? '✅ 成功' : '❌ 失败'}（退出码 ${res.code}${res.timedOut ? '，超时' : ''}，${res.durationMs}ms）`,
      ];
      if (dist.exists && res.ok) {
        lines.push('', `产物 dist/：${dist.fileCount} 个文件，${dist.totalText}（index.html ${dist.mtime}）`);
        for (const f of dist.files.slice(0, 8)) lines.push(`  ${f.sizeText.padStart(9)}  ${f.rel}`);
      }
      if (!res.ok) {
        const verrs = parseViteErrors(raw);
        if (verrs.length) lines.push('', '错误摘要：', ...verrs.map((e) => `  [${e.source}] ${e.message}`));
        lines.push('', truncate(raw.trim(), 8000));
      }
      const data = { ok: res.ok, code: res.code, durationMs: res.durationMs, dist };
      return res.ok ? ok(lines.join('\n'), data) : fail(lines.join('\n'), data);
    },
  },

  {
    name: 'bossclaw_verify',
    title: '完整验证（typecheck + build）',
    description:
      '串行执行类型检查与生产构建，返回一张结论表。任何代码改动后的标准验证入口 —— ' +
      '对应 package.json 的 npm run verify。',
    annotations: WRITE_LOCAL,
    inputSchema: obj({
      timeoutSec: num('整体超时秒数（默认 600）', { default: 600 }),
      skipBuild: bool('只做类型检查（默认 false）', { default: false }),
    }),
    handler: async (args = {}) => {
      const timeoutMs = Math.min(Math.max(Number(args.timeoutSec) || 600, 10), 2400) * 1000;
      const rows = [];
      const detail = [];

      const tc = await runTypecheck(timeoutMs);
      const tcRaw = `${tc.stdout}\n${tc.stderr}`;
      const tcErrors = parseTsErrors(tcRaw);
      rows.push({ step: 'tsc -b（类型检查）', result: tc.ok ? 'PASS' : 'FAIL', code: tc.code, ms: tc.durationMs, extra: tcErrors.length ? `${tcErrors.length} 条诊断` : '' });
      if (!tc.ok) detail.push('### tsc -b 输出', '', truncate(tcRaw.trim(), 8000));

      let dist = null;
      if (!args.skipBuild && tc.ok) {
        const bd = await runBuild(timeoutMs - tc.durationMs > 30_000 ? timeoutMs - tc.durationMs : 120_000);
        dist = await distSummary();
        rows.push({
          step: 'vite build（生产构建）',
          result: bd.ok ? 'PASS' : 'FAIL',
          code: bd.code,
          ms: bd.durationMs,
          extra: bd.ok && dist.exists ? `${dist.fileCount} 文件 / ${dist.totalText}` : '',
        });
        if (!bd.ok) detail.push('### vite build 输出', '', truncate(`${bd.stdout}\n${bd.stderr}`.trim(), 8000));
      } else if (args.skipBuild) {
        rows.push({ step: 'vite build（生产构建）', result: 'SKIP', code: null, ms: 0, extra: '按要求跳过' });
      } else {
        rows.push({ step: 'vite build（生产构建）', result: 'SKIP', code: null, ms: 0, extra: '类型检查未通过，先修错' });
      }

      const failed = rows.filter((r) => r.result === 'FAIL');
      const skipped = rows.filter((r) => r.result === 'SKIP');
      const verdict = failed.length
        ? `❌ 未通过（${failed.length} 步失败：${failed.map((f) => f.step).join('、')}）`
        : skipped.length
          ? `⚠️ 通过（跳过 ${skipped.length} 步：${skipped.map((s) => s.step).join('、')}）`
          : '✅ 全部通过';
      const lines = [
        `验证结论：${verdict}`,
        '',
        '| 步骤 | 结果 | 退出码 | 耗时 | 备注 |',
        '| --- | --- | --- | --- | --- |',
        ...rows.map((r) => `| ${r.step} | ${r.result} | ${r.code ?? '-'} | ${r.ms}ms | ${r.extra || '-'} |`),
        '',
        ...detail,
      ];
      const data = { rows, dist, ok: failed.length === 0, failed: failed.length, skipped: skipped.length };
      return failed.length === 0 ? ok(lines.join('\n'), data) : fail(lines.join('\n'), data);
    },
  },

  {
    name: 'bossclaw_check_fresh',
    title: '检查 dist 是否新鲜',
    description:
      '运行 scripts/check-fresh.mjs：判断 dist/index.html 是否早于渲染层源码（src/、index.html、vite.config.ts）。' +
      '退出码 0=新鲜可直接启动 / 1=需重建 / 2=dist 缺失。',
    annotations: READ_ONLY,
    inputSchema: obj({}),
    handler: async () => {
      const st = await statSafe(PATHS.checkFresh);
      if (!st.exists) return fail(`未找到 ${PATHS.checkFresh}`);
      const res = await run(NODE_BIN, [PATHS.checkFresh], { cwd: DESKTOP_DIR, timeoutMs: 60_000 });
      const verdict = { 0: '新鲜：dist 可直接启动', 1: '需要重建：源码比 dist 新', 2: 'dist 缺失，需先构建' }[res.code] || `未知退出码 ${res.code}`;
      const lines = [
        `check-fresh：退出码 ${res.code} → ${verdict}`,
        '',
        '| 退出码 | 含义 |',
        '| --- | --- |',
        '| 0 | 新鲜，无需重建 |',
        '| 1 | 源码更新，需重建 |',
        '| 2 | dist 缺失 |',
      ];
      if (res.stderr.trim()) lines.push('', 'stderr：', truncate(res.stderr.trim(), 2000));
      return ok(lines.join('\n'), { exitCode: res.code, verdict, fresh: res.code === 0 });
    },
  },

  {
    name: 'bossclaw_package',
    title: '打包 Windows 安装包',
    description:
      '执行「vite build + electron-builder --win」，产物写入 desktop-app/release/。' +
      '耗时数分钟，**默认后台执行**并返回 jobId，用 bossclaw_job 轮询进度与产物。',
    annotations: WRITE_LOCAL,
    inputSchema: obj({
      target: enumStr('打包目标', ['nsis', 'portable', 'dir']),
      background: bool('后台执行（默认 true）', { default: true }),
      timeoutSec: num('前台等待超时秒数（默认 900）', { default: 900 }),
    }),
    handler: async (args = {}) => {
      const target = args.target || 'nsis';
      const ebArgs = [path.join(DESKTOP_DIR, 'node_modules', 'electron-builder', 'cli.js'), '--win'];
      if (target === 'portable') ebArgs.push('portable');
      if (target === 'dir') ebArgs.push('--dir');
      const background = args.background !== false;
      const runner = path.join(MCP_DIR, 'src', 'runners', 'package.mjs');

      const collectArtifacts = async () => {
        const artifacts = [];
        for (const f of await fsp.readdir(PATHS.releaseDir).catch(() => [])) {
          const s = await statSafe(path.join(PATHS.releaseDir, f));
          if (s.exists && !s.isDir) artifacts.push({ name: f, sizeText: humanBytes(s.size), size: s.size, mtime: s.mtime });
        }
        return artifacts;
      };

      if (background) {
        const job = startJob({ label: `package --win ${target}`, cmd: NODE_BIN, args: [runner, target], cwd: DESKTOP_DIR });
        return ok(
          `已后台启动打包（vite build → electron-builder --win ${target}），jobId=${job.id}。\n` +
            `轮询：bossclaw_job action=output id=${job.id}；完成后产物在 ${PATHS.releaseDir}`,
          { jobId: job.id, target, releaseDir: PATHS.releaseDir }
        );
      }

      const res = await run(NODE_BIN, [runner, target], {
        cwd: DESKTOP_DIR,
        timeoutMs: Math.min(Math.max(Number(args.timeoutSec) || 900, 60), 3600) * 1000,
      });
      const artifacts = await collectArtifacts();
      const lines = [
        `打包（vite build → electron-builder --win ${target}）：${res.ok ? '✅ 成功' : '❌ 失败'}（退出码 ${res.code}${res.timedOut ? '，超时' : ''}，${Math.round(res.durationMs / 1000)}s）`,
        '',
        'release/ 产物：',
        artifacts.length ? artifacts.map((a) => `  ${a.sizeText.padStart(9)}  ${a.name}  ${a.mtime}`).join('\n') : '  (无)',
      ];
      if (!res.ok) lines.push('', truncate(`${res.stdout}\n${res.stderr}`.trim().slice(-12000), 8000));
      const data = { ok: res.ok, artifacts, code: res.code };
      return res.ok ? ok(lines.join('\n'), data) : fail(lines.join('\n'), data);
    },
  },

  {
    name: 'bossclaw_job',
    title: '后台任务管理',
    description: '管理后台任务（构建 / 打包等）：list 列出、output 查看输出尾部、kill 终止。',
    annotations: WRITE_LOCAL,
    inputSchema: obj(
      {
        action: enumStr('操作', ['list', 'output', 'kill']),
        id: str('任务 id（output / kill 必填）'),
        tail: num('output 返回的输出尾部行数（默认 60）', { default: 60 }),
      },
      ['action']
    ),
    handler: async (args) => {
      if (args.action === 'list') {
        const jobs = listJobs();
        if (!jobs.length) return ok('当前没有后台任务。', { jobs: [] });
        const lines = [
          '| id | 标签 | 状态 | 退出码 | 耗时 |',
          '| --- | --- | --- | --- | --- |',
          ...jobs.map((j) => `| ${j.id} | ${j.label} | ${j.status} | ${j.code ?? '-'} | ${Math.round(j.durationMs / 1000)}s |`),
        ];
        return ok(lines.join('\n'), { jobs });
      }
      if (!args.id) return fail('需要 id');
      if (args.action === 'kill') {
        const j = await killJob(args.id);
        if (!j) return fail(`未找到任务 ${args.id}`);
        return ok(`已终止 ${j.id}（状态 ${j.status}）`, j);
      }
      const j = jobOutput(args.id, Math.min(Math.max(Number(args.tail) || 60, 5), 2000));
      if (!j) return fail(`未找到任务 ${args.id}`);
      const lines = [
        `${j.id}｜${j.label}｜${j.status}（退出码 ${j.code ?? '-'}，${Math.round(j.durationMs / 1000)}s）`,
        '',
        `--- stdout（尾 ${args.tail || 60} 行，共 ${j.stdoutBytes} 字符）---`,
        j.stdoutTail || '(空)',
        '',
        `--- stderr ---`,
        j.stderrTail || '(空)',
      ];
      return ok(lines.join('\n'), j);
    },
  },
];
