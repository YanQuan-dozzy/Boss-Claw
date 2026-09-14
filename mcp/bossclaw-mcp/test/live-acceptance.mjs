// test/live-acceptance.mjs —— 真实 MCP 客户端验收
// ---------------------------------------------------------------------------
// 与 selftest / bridge-e2e 的区别：
//   · selftest        —— 只测协议与只读工具（不需要应用在运行）
//   · bridge-e2e      —— 自起隔离实例，测全链路（会把应用起起来再关掉）
//   · live-acceptance —— **按 MCP 客户端登记的原始命令**拉起服务，去打**用户正在运行的那个实例**
//                        （读 ~/.workbuddy/mcp.json 的 mcpServers.bossclaw，不自己拼命令）
//
// 前提：应用正以控制桥运行（start-bossclaw.cmd 默认开启，或 bossclaw_app_start）。
// 用法：node test/live-acceptance.mjs
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const DESKTOP = path.join(REPO_ROOT, 'desktop-app');
const MCP_JSON = path.join(os.homedir(), '.workbuddy', 'mcp.json');

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---- 1) 读登记信息，按客户端的方式启动服务 ----
const regRaw = await fsp.readFile(MCP_JSON, 'utf8').catch(() => null);
if (!regRaw) {
  console.error(`❌ 读不到 ${MCP_JSON}`);
  process.exit(1);
}
const reg = JSON.parse(regRaw).mcpServers?.bossclaw;
if (!reg?.command) {
  console.error('❌ mcp.json 里没有注册 bossclaw 服务');
  process.exit(1);
}
const args = (reg.args || []).map((a) => a.replace(/%([^%]+)%/g, (_, k) => process.env[k] ?? _));
console.log(`登记命令：${reg.command}`);
console.log(`      参数：${args.join(' ')}\n`);

const env = { ...process.env };
for (const k of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'PYTHONPATH']) delete env[k];
if (reg.env) Object.assign(env, reg.env);
// 固定面向**开发仓库**（而非自动探测到的已安装版 <安装目录>），保证 repo 工具路径解析正确
if (!env.BOSSCLAW_REPO) env.BOSSCLAW_REPO = REPO_ROOT;

const child = spawn(reg.command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

let buffer = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error('❌ stdout 出现非 JSON 内容：', line.slice(0, 160));
      process.exitCode = 1;
      continue;
    }
    const r = pending.get(msg.id);
    if (r) {
      pending.delete(msg.id);
      r(msg);
    }
  }
});
const stderrBuf = [];
child.stderr.on('data', (c) => stderrBuf.push(c.toString('utf8')));

let seq = 0;
function rpc(method, params, timeoutMs = 180_000) {
  seq += 1;
  const id = seq;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`超时：${method}`));
      }
    }, timeoutMs);
  });
}
const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`);

const tool = async (name, argsIn = {}) => {
  const res = await rpc('tools/call', { name, arguments: argsIn });
  const content = res.result?.content || [];
  const text = content.find((c) => c.type === 'text')?.text || '';
  const images = content.filter((c) => c.type === 'image');
  return { isError: res.result?.isError === true, text, images, data: res.result?.structuredContent, error: res.error };
};

let shotPath = null;
try {
  // ---- 2) 握手 ----
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'bossclaw-live-acceptance', version: '1.0.0' },
  });
  record(
    'initialize 握手（按登记命令启动）',
    init.result?.serverInfo?.name === 'bossclaw-mcp',
    `${init.result?.serverInfo?.name}@${init.result?.serverInfo?.version} / protocol ${init.result?.protocolVersion}`
  );
  notify('notifications/initialized');

  const list = await rpc('tools/list');
  const tools = list.result?.tools || [];
  record('tools/list', tools.length === 23, `${tools.length} 个工具`);

  // ---- 3) 只读认知类（对真实仓库）----
  const info = await tool('bossclaw_project_info');
  record('bossclaw_project_info', !info.isError && info.text.includes('BossClaw 项目总览'), (info.data?.app?.version ? `v${info.data.app.version}` : '') + ` / 路由 ${info.data?.routes?.count} 个`);
  record(
    '  └ 识别到应用正在运行',
    info.data?.appRuntime?.running === true,
    `进程 ${info.data?.appRuntime?.processCount} 个（detect=${info.data?.appRuntime?.detectMethod}）`
  );
  record('  └ 识别到控制桥', !!info.data?.appRuntime?.controlBridge && !info.data.appRuntime.controlBridge.stale, `port=${info.data?.appRuntime?.controlBridge?.port}`);

  const fresh = await tool('bossclaw_state_summary');
  record('bossclaw_state_summary', !fresh.isError, fresh.text.split('\n')[0].slice(0, 80));

  const search = await tool('bossclaw_search', { pattern: 'resolveEnablement', glob: 'cjs', subdir: 'desktop-app/electron', maxResults: 5 });
  record('bossclaw_search', !search.isError && (search.data?.hits?.length || 0) > 0, `命中 ${search.data?.hits?.length} 行`);

  const read = await tool('bossclaw_read_file', { path: 'desktop-app/electron/main.cjs', offset: 1, limit: 4 });
  record('bossclaw_read_file', !read.isError, read.text.split('\n')[0].slice(0, 90));

  // ---- 4) 运行态（真实应用）----
  const st = await tool('bossclaw_app_status');
  record('bossclaw_app_status', !st.isError && st.data?.running === true, `控制桥 ${st.data?.bridge ? '健康' : '未就绪'}`);

  const summary = await tool('bossclaw_state_summary');
  record('bossclaw_state_summary', !summary.isError, `${summary.data?.pending?.total ?? '-'} 个岗位｜${summary.data?.readiness?.resume ? '简历已导入' : '简历未导入'}`);

  const logs = await tool('bossclaw_logs', { target: 'app', lines: 5 });
  record('bossclaw_logs', !logs.isError && logs.text.includes('control bridge'), '日志含 control bridge 记录');

  // ---- 5) 实时应用控制（控制桥）----
  const live = await tool('bossclaw_app_state');
  record(
    'bossclaw_app_state（实时内存状态）',
    !live.isError && !!live.data?.app,
    live.isError ? live.text.split('\n')[0].slice(0, 100) : `route=${live.data.app.activeRoute} theme=${live.data.app.theme}`
  );

  const engine = await tool('bossclaw_engine_status');
  record('bossclaw_engine_status', !engine.isError, engine.text.split('\n').find((l) => l.includes('Camoufox 桥'))?.trim().slice(0, 70) || '');

  // 截图：证明「agent 能看见界面」以及 image 内容块可用
  const shot = await tool('bossclaw_app_action', { action: 'screenshot', params: {} });
  if (!shot.isError && shot.images.length === 1) {
    const buf = Buffer.from(shot.images[0].data, 'base64');
    const dir = path.join(DESKTOP, 'tmp');
    await fsp.mkdir(dir, { recursive: true });
    shotPath = path.join(dir, `mcp-acceptance-${Date.now()}.png`);
    await fsp.writeFile(shotPath, buf);
    record('bossclaw_app_action screenshot', buf.subarray(0, 4).toString('hex') === '89504e47', `${Math.round(buf.length / 1024)}KB → ${shotPath}`);
  } else {
    record('bossclaw_app_action screenshot', false, shot.text.split('\n')[0].slice(0, 120));
  }

  const back = await tool('bossclaw_app_action', { action: 'navigate', params: { route: live.data?.app?.activeRoute || 'home' } });
  record('bossclaw_app_action navigate（原地切回，无副作用）', !back.isError, back.text.split('\n')[0]);
} catch (e) {
  record('验收执行', false, String(e?.message || e));
} finally {
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 800));
  child.kill();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过${failed.length ? `；失败：${failed.map((f) => f.name).join('、')}` : ''}`);
  if (shotPath) console.log(`截图：${shotPath}`);
  if (failed.length) {
    console.log('\n--- 服务 stderr ---');
    console.log(stderrBuf.join('').slice(-3000));
  }
  process.exit(failed.length ? 1 : 0);
}
