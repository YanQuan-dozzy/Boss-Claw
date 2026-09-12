// test/selftest.mjs —— MCP 协议自检
// 以真实子进程方式启动服务，完成 initialize / tools/list / tools/call 握手，
// 并对若干只读工具做实际调用，验证服务可用。
// 用法：node test/selftest.mjs [--all]
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'bin', 'bossclaw-mcp.mjs');
const runAll = process.argv.includes('--all');

const spawnEnv = process.env.BOSSCLAW_REPO
  ? { ...process.env }
  : { ...process.env, BOSSCLAW_REPO: path.resolve(__dirname, '..', '..', '..') };
const child = spawn(process.execPath, [BIN], { stdio: ['pipe', 'pipe', 'pipe'], env: spawnEnv });

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
    } catch (e) {
      console.error('❌ 收到非 JSON 的 stdout 行：', line.slice(0, 200));
      process.exitCode = 1;
      continue;
    }
    const resolver = pending.get(msg.id);
    if (resolver) {
      pending.delete(msg.id);
      resolver(msg);
    } else {
      console.error('⚠️ 收到无法对应的消息：', JSON.stringify(msg).slice(0, 200));
    }
  }
});

const stderrChunks = [];
child.stderr.on('data', (c) => stderrChunks.push(c.toString('utf8')));

let seq = 0;
function rpc(method, params) {
  seq += 1;
  const id = seq;
  const payload = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`请求超时：${method}`));
      }
    }, 120_000);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`);
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!pass) process.exitCode = 1;
}

try {
  // 1) initialize
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'bossclaw-mcp-selftest', version: '1.0.0' },
  });
  const info = init.result;
  record('initialize 握手', !!info?.protocolVersion && info?.serverInfo?.name === 'bossclaw-mcp', `protocol=${info?.protocolVersion} server=${info?.serverInfo?.name}@${info?.serverInfo?.version}`);
  record('instructions 已下发', typeof info?.instructions === 'string' && info.instructions.includes('bossclaw_guidelines'));
  notify('notifications/initialized');

  // 2) ping
  const pong = await rpc('ping');
  record('ping', pong.result !== undefined);

  // 3) tools/list
  const list = await rpc('tools/list');
  const tools = list.result?.tools || [];
  record('tools/list', tools.length > 0, `${tools.length} 个工具`);
  const badSchema = tools.filter((t) => !t.name || !t.description || !t.inputSchema || t.inputSchema.type !== 'object');
  record('工具 schema 完整', badSchema.length === 0, badSchema.map((t) => t.name).join(', ') || '全部合法');
  const groups = tools.reduce((acc, t) => {
    const g = t.name.replace(/^bossclaw_/, '').split('_')[0];
    acc[g] = (acc[g] || 0) + 1;
    return acc;
  }, {});
  console.log(`   工具分组：${Object.entries(groups).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  // 4) 只读工具实测
  const readOnlySamples = [
    ['bossclaw_project_info', {}],
    ['bossclaw_check_fresh', {}],
    ['bossclaw_app_status', {}],
    ['bossclaw_state_summary', {}],
    ['bossclaw_engine_status', {}],
    ['bossclaw_search', { pattern: 'SAFETY_LIMITS', glob: 'ts', subdir: 'desktop-app/src', maxResults: 5 }],
    ['bossclaw_list_dir', { path: 'desktop-app/src/store', depth: 1 }],
    ['bossclaw_read_file', { path: 'desktop-app/package.json', limit: 5 }],
    ['bossclaw_git', { action: 'status' }],
    ['bossclaw_ipc_surface', { channel: 'jc:cloak' }],
    ['bossclaw_state_read', { key: 'bossclaw-app', mode: 'summary' }],
    ['bossclaw_logs', { target: 'app', lines: 3 }],
    ['bossclaw_job', { action: 'list' }],
    ['bossclaw_app_state', {}],
    ['bossclaw_app_action', { action: 'navigate', params: { route: 'home' } }],
  ];
  const CONTROl_DEPENDENT = ['bossclaw_app_state', 'bossclaw_app_action', 'bossclaw_app_status'];
  for (const [name, args] of runAll ? readOnlySamples : readOnlySamples.filter(([n]) => !['bossclaw_git'].includes(n))) {
    const res = await rpc('tools/call', { name, arguments: args });
    const text = res.result?.content?.[0]?.text || '';
    const isError = res.result?.isError === true;
    // 控制桥未开启时，这些工具「失败但给出明确启用指引」才是正确行为
    const mayFail = CONTROl_DEPENDENT.includes(name) ? '（控制桥未开启时预期失败）' : '';
    record(`tools/call ${name}`, !res.error && text.length > 0 && (!isError || mayFail !== ''), `${text.split('\n')[0].slice(0, 110)}${mayFail}`);
  }

  // 5) 错误处理
  const bad = await rpc('tools/call', { name: 'bossclaw_不存在', arguments: {} });
  record('未知工具返回错误', !!bad.error);
  const missingParam = await rpc('tools/call', { name: 'bossclaw_read_file', arguments: {} });
  record('缺参返回 isError', missingParam.result?.isError === true);
  const unknownMethod = await rpc('nonexistent/method');
  record('未知方法返回 -32601', unknownMethod.error?.code === -32601);
} catch (e) {
  record('自检执行', false, String(e?.message || e));
} finally {
  child.stdin.end();
  child.kill();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过${failed.length ? `，失败：${failed.map((f) => f.name).join(', ')}` : ''}`);
  if (failed.length) {
    console.log('\n--- 服务 stderr ---');
    console.log(stderrChunks.join('').slice(-4000));
  }
  process.exit(process.exitCode || 0);
}
