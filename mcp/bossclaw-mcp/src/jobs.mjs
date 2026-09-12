// src/jobs.mjs —— 后台任务注册表
// ---------------------------------------------------------------------------
// 打包（electron-builder）等长耗时命令不能在一次 MCP 调用里干等（客户端会超时），
// 因此支持后台执行 + 轮询输出。
import { spawnBackground, killTree } from './context.mjs';

const jobs = new Map();
let seq = 0;
const MAX_CAPTURE = 1024 * 1024;

function append(job, chunk, which) {
  const text = chunk.toString('utf8');
  job[which] += text;
  if (job[which].length > MAX_CAPTURE) {
    job[which] = `${job[which].slice(0, 200 * 1024)}\n... [中段截断] ...\n${job[which].slice(-400 * 1024)}`;
  }
}

export function startJob({ label, cmd, args = [], cwd, env = {} }) {
  seq += 1;
  const id = `job-${seq}-${Date.now().toString(36)}`;
  const job = {
    id,
    label,
    cmd: [cmd, ...args].join(' '),
    cwd,
    startedAt: Date.now(),
    endedAt: null,
    status: 'running',
    code: null,
    signal: null,
    stdout: '',
    stderr: '',
    pid: null,
  };
  jobs.set(id, job);
  spawnBackground(cmd, args, { cwd, env })
    .then((child) => {
      job.pid = child.pid;
      child.stdout?.on('data', (d) => append(job, d, 'stdout'));
      child.stderr?.on('data', (d) => append(job, d, 'stderr'));
      child.on('error', (e) => {
        job.status = 'failed';
        job.endedAt = Date.now();
        job.stderr += `\n[spawn error] ${e?.message || e}`;
      });
      child.on('close', (code, signal) => {
        job.code = code;
        job.signal = signal;
        job.endedAt = Date.now();
        job.status = code === 0 ? 'done' : 'failed';
      });
    })
    .catch((e) => {
      job.status = 'failed';
      job.endedAt = Date.now();
      job.stderr += `\n[spawn failed] ${e?.message || e}`;
    });
  return job;
}

function publicView(job, { tail } = {}) {
  const since = job.startedAt;
  const view = {
    id: job.id,
    label: job.label,
    cmd: job.cmd,
    pid: job.pid,
    status: job.status,
    code: job.code,
    startedAt: new Date(since).toISOString(),
    endedAt: job.endedAt ? new Date(job.endedAt).toISOString() : null,
    durationMs: (job.endedAt || Date.now()) - since,
  };
  if (tail) {
    view.stdoutTail = tailText(job.stdout, tail);
    view.stderrTail = tailText(job.stderr, tail);
    view.stdoutBytes = job.stdout.length;
    view.stderrBytes = job.stderr.length;
  }
  return view;
}

function tailText(text, n) {
  if (!text) return '';
  const lines = text.split(/\r?\n/);
  return lines.slice(-Math.max(1, n)).join('\n');
}

export function listJobs() {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map((j) => publicView(j));
}

export function jobOutput(id, tail = 80) {
  const job = jobs.get(id);
  if (!job) return null;
  return publicView(job, { tail });
}

export async function killJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status === 'running' && job.pid) await killTree(job.pid);
  return publicView(job, { tail: 40 });
}
