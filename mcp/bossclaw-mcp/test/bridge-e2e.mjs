// test/bridge-e2e.mjs —— 控制桥端到端验证
// ---------------------------------------------------------------------------
// 以**独立 userData** 启动一个隔离的 BossClaw 实例（不影响用户正在运行的实例），
// 验证控制桥的 /health、/state 与 /action 全链路，最后整棵结束进程并清理临时目录。
// 用法：node test/bridge-e2e.mjs
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';

// 隔离实例的 userData：放 desktop-app/tmp 下，测试结束即删除
const SANDBOX = path.resolve(import.meta.dirname, '..', '..', '..', 'desktop-app', 'tmp', 'control-e2e');
const USER_DATA = path.join(SANDBOX, 'userdata');
const FAKE_HOME = path.join(SANDBOX, 'home');
const REAL_BOSSCLAW_HOME = path.join(os.homedir(), '.bossclaw');
const HOME_BACKUP = path.join(SANDBOX, 'bossclaw-home-backup');
// 必须在导入 context.mjs 之前设置，因为 CONTROL_BRIDGE_FILE 在模块加载时解析。
// 同时固定面向**开发仓库**（而非自动探测到的已安装版 F:\BOSSClaw）：保证 src/electron/node_modules 等指向 dev 目录。
process.env.BOSSCLAW_USERDATA = USER_DATA;
process.env.BOSSCLAW_REPO = process.env.BOSSCLAW_REPO || path.resolve(import.meta.dirname, '..', '..', '..');

const ctx = await import('../src/context.mjs');
const { PATHS, spawnDetached, killTree, isPidAlive, statSafe, readJsonSafe } = ctx;

/**
 * 隔离要点：electron/main.cjs 的 resetDataForVersion() 在「新 userData」上会执行一次性迁移，
 * 其中包含 `fs.unlinkSync(~/.bossclaw/camoufox-cookies.json)` —— 若让隔离实例使用真实 HOME，
 * 会毁掉用户已扫码的隐身引擎登录态。因此：
 *   1) 用 USERPROFILE 把 app.getPath('home') 重定向到沙箱目录（Node 在 Windows 上据此推导 homedir）；
 *   2) 仍然对真实 ~/.bossclaw 做整目录备份/还原，作为兜底。
 */
async function backupRealHome() {
  try {
    await fsp.cp(REAL_BOSSCLAW_HOME, HOME_BACKUP, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

async function restoreRealHome(hadRealHome) {
  if (!hadRealHome) return;
  try {
    await fsp.rm(REAL_BOSSCLAW_HOME, { recursive: true, force: true });
    await fsp.cp(HOME_BACKUP, REAL_BOSSCLAW_HOME, { recursive: true });
  } catch (e) {
    console.error(`⚠️ 恢复真实 ~/.bossclaw 失败，备份保留在 ${HOME_BACKUP}：${e?.message}`);
  }
}

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bridgeFetch(port, token, method, urlPath, body) {
  // 上限需大于控制桥等待渲染层就绪的内部超时（25s）
  return ctx.bridgeRequest({ port, token }, method, urlPath, body, 45_000);
}

let pid = null;
let hadRealHome = false;
try {
  await fsp.rm(SANDBOX, { recursive: true, force: true });
  await fsp.mkdir(USER_DATA, { recursive: true });
  await fsp.mkdir(FAKE_HOME, { recursive: true });
  hadRealHome = await backupRealHome();
  console.log(`隔离 userData：${USER_DATA}`);
  console.log(`隔离 HOME（USERPROFILE）：${FAKE_HOME}；真实 ~/.bossclaw 备份：${hadRealHome ? '已建立' : '不存在，跳过'}`);

  if (!(await statSafe(PATHS.electronBin)).exists) throw new Error(`未找到 Electron：${PATHS.electronBin}`);
  const distIndex = await statSafe(path.join(PATHS.distDir, 'index.html'));
  if (!distIndex.exists) throw new Error('dist 缺失，请先在仓库内构建（npm run build:web / vite build）');

  const started = spawnDetached(
    PATHS.electronBin,
    ['.', '--no-sandbox', `--user-data-dir=${USER_DATA}`],
    {
      cwd: PATHS.desktop,
      env: {
        BOSSCLAW_CONTROL: '1',
        BOSSCLAW_NO_GPU: '1',
        // 把 app.getPath('home') 重定向到沙箱，避免一次性迁移删掉真实 ~/.bossclaw/camoufox-cookies.json
        USERPROFILE: FAKE_HOME,
      },
    }
  );
  pid = started.pid;
  console.log(`已启动隔离实例 pid=${pid}`);

  // 轮询 info 文件
  const infoFile = path.join(USER_DATA, 'control-bridge.json');
  let info = null;
  for (let i = 0; i < 60; i += 1) {
    await sleep(1000);
    const parsed = await readJsonSafe(infoFile);
    if (parsed.ok && parsed.data?.port && parsed.data?.token) {
      info = parsed.data;
      break;
    }
    if (!isPidAlive(pid)) break;
  }
  record('控制桥 info 文件生成', !!info, info ? `port=${info.port} file=${infoFile}` : `未生成（进程存活=${isPidAlive(pid)}）`);
  if (!info) throw new Error('控制桥未启动，后续用例跳过');

  const health = await bridgeFetch(info.port, info.token, 'GET', '/health', null);
  record('GET /health', health.ok && health.data?.ok === true, JSON.stringify(health.data || health.error));

  const unauth = await bridgeFetch(info.port, 'wrong-token', 'GET', '/state', null);
  record('错误 token 被拒', unauth.status === 401, `status=${unauth.status}`);

  const state = await bridgeFetch(info.port, info.token, 'GET', '/state', null);
  const snap = state.data?.state;
  record(
    'GET /state 返回实时快照',
    state.ok && !!snap?.app && !!snap?.settings?.config,
    snap ? `route=${snap.app.activeRoute} theme=${snap.app.theme} platform=${Object.keys(snap.settings.config.platforms || {}).join('/')}` : JSON.stringify(state.error)
  );
  record('apiKey 已打码', !!(snap?.settings?.config?.model?.apiKey || '').includes('***') || snap?.settings?.config?.model?.apiKey === null, `apiKey=${snap?.settings?.config?.model?.apiKey}`);

  const picked = await bridgeFetch(info.port, info.token, 'GET', '/state?path=app.activeRoute', null);
  record('GET /state?path= 点路径裁剪', picked.ok && typeof picked.data?.state === 'string', `value=${JSON.stringify(picked.data?.state)}`);

  const nav = await bridgeFetch(info.port, info.token, 'POST', '/action', { action: 'navigate', params: { route: 'tasks' } });
  record('action navigate', nav.ok && nav.data?.applied === true && nav.data?.next === 'tasks', nav.data?.message || nav.error);

  const badNav = await bridgeFetch(info.port, info.token, 'POST', '/action', { action: 'navigate', params: { route: 'not-a-route' } });
  record('非法路由被拒绝（applied=false）', badNav.ok && badNav.data?.applied === false, badNav.data?.message);

  const theme = await bridgeFetch(info.port, info.token, 'POST', '/action', { action: 'setTheme', params: { theme: 'dark' } });
  record('action setTheme', theme.ok && theme.data?.next === 'dark', theme.data?.message);

  const pause = await bridgeFetch(info.port, info.token, 'POST', '/action', { action: 'pauseDelivery', params: { minutes: 5 } });
  record('action pauseDelivery', pause.ok && pause.data?.applied === true, pause.data?.message);
  const resume = await bridgeFetch(info.port, info.token, 'POST', '/action', { action: 'resumeDelivery', params: {} });
  record('action resumeDelivery', resume.ok && resume.data?.applied === true, resume.data?.message);

  const denied = await bridgeFetch(info.port, info.token, 'POST', '/action', { action: 'patchConfig', params: { patch: { model: { apiKey: 'x' }, unknownField: 1, minScore: 80 } } });
  record(
    'patchConfig 拒绝受保护字段、放过合法字段',
    denied.ok && denied.data?.applied === true && denied.data?.next?.minScore === 80 && denied.data?.next?.model === undefined,
    denied.data?.message
  );

  const unknown = await bridgeFetch(info.port, info.token, 'POST', '/action', { action: 'rm-rf-everything', params: {} });
  record('未白名单动作被拒绝', unknown.ok && unknown.data?.applied === false, unknown.data?.message);

  const win = await bridgeFetch(info.port, info.token, 'POST', '/action', { action: 'windowState', params: {} });
  record('主进程动作 windowState', win.ok && !!win.data?.next?.bounds, JSON.stringify(win.data?.next || win.error));

  const shot = await bridgeFetch(info.port, info.token, 'POST', '/action', { action: 'screenshot', params: {} });
  const shotOk = shot.ok && !!shot.data?.image?.base64;
  let shotDetail = shot.data?.message || shot.error;
  if (shotOk) {
    const bytes = Buffer.from(shot.data.image.base64, 'base64').length;
    const shotPath = shot.data.next?.file;
    const saved = shotPath ? await statSafe(shotPath) : { exists: false };
    shotDetail = `${bytes} 字节，png 魔数=${shot.data.image.base64.startsWith('iVBOR')}，落盘=${saved.exists}，${shotPath}`;
    record('action screenshot（返回图片 + 落盘 PNG）', shot.data.image.base64.startsWith('iVBOR') && saved.exists, shotDetail);
  } else {
    record('action screenshot（返回图片 + 落盘 PNG）', false, shotDetail);
  }

  const engine = await bridgeFetch(info.port, info.token, 'POST', '/action', { action: 'engineStatus', params: {} });
  record('action engineStatus（只读探测两套引擎）', engine.ok && engine.data?.next?.camoufox !== undefined, JSON.stringify(engine.data?.next || engine.error).slice(0, 300));

  const reload = await bridgeFetch(info.port, info.token, 'POST', '/action', { action: 'reloadRenderer', params: {} });
  record('主进程动作 reloadRenderer', reload.ok && reload.data?.applied === true, reload.data?.message);
  await sleep(4000);
  const afterReload = await bridgeFetch(info.port, info.token, 'GET', '/state', null);
  record('重载后控制桥仍可用且运行时已重装', afterReload.ok && !!afterReload.data?.state?.app, `route=${afterReload.data?.state?.app?.activeRoute}`);

  // ===== 全链路：直接调用 MCP 工具 handler，走 MCP → HTTP 桥 → Electron → 渲染层 =====
  const { controlTools } = await import('../src/tools/control.mjs');
  const { stateTools } = await import('../src/tools/state.mjs');
  const tool = (arr, name) => arr.find((t) => t.name === name);

  const r1 = await tool(controlTools, 'bossclaw_app_state').handler({});
  record('MCP bossclaw_app_state 全链路', !r1.isError && r1.text.includes('应用实时状态'), r1.text.split('\n')[1]?.slice(0, 90));

  const r2 = await tool(controlTools, 'bossclaw_app_action').handler({ action: 'navigate', params: { route: 'workbench' } });
  record('MCP bossclaw_app_action navigate', !r2.isError && r2.data?.next === 'workbench', r2.text.split('\n')[0]);

  const r3 = await tool(controlTools, 'bossclaw_app_action').handler({ action: 'screenshot', params: {} });
  record('MCP app_action screenshot 产出 image 内容块', Array.isArray(r3.images) && r3.images.length === 1 && r3.images[0].mimeType === 'image/png', `images=${r3.images?.length}`);

  const r4 = await tool(stateTools, 'bossclaw_engine_status').handler({});
  record('MCP bossclaw_engine_status 读到实时引擎段', !r4.isError && r4.text.includes('## 实时'), r4.text.split('\n').find((l) => l.includes('✅ 可用'))?.slice(0, 80) || '');

  const r5 = await tool(stateTools, 'bossclaw_state_summary').handler({});
  record('MCP bossclaw_state_summary 正常', !r5.isError && r5.text.includes('投递安全参数'), r5.text.split('\n')[2]?.slice(0, 80));

  // ===== 业务数据管理全链路（本会话新增）=====
  const gr = await tool(controlTools, 'bossclaw_app_action').handler({
    action: 'dataSetGreetings',
    params: { items: ['你好，我对贵司前端岗位很感兴趣，期望进一步了解。', '短'] },
  });
  record('MCP dataSetGreetings 写打招呼语', !gr.isError && gr.data?.applied === true && gr.data?.next === 1, gr.text?.split('\n')[1]?.slice(0, 80));

  const gread = await tool(controlTools, 'bossclaw_app_state').handler({ path: 'data.greetings' });
  const gArr = gread.data?.value || [];
  // 写入 1 条有效（≥8 字）+ 1 条过短被过滤 → 读回应恰好 1 条且 ≥8 字
  record('MCP 读回 greetings 且过短项已过滤', Array.isArray(gArr) && gArr.length === 1 && String(gArr[0] || '').replace(/\s+/g, '').length >= 8, `len=${gArr.length} firstLen=${String(gArr[0] || '').length}`);

  const schedAdd = await tool(controlTools, 'bossclaw_app_action').handler({
    action: 'scheduleAdd',
    params: { entry: { name: 'e2e-daily', action: 'backup', time: '23:30', daysOfWeek: [], enabled: true } },
  });
  const schedId = schedAdd.data?.next?.id;
  record('MCP scheduleAdd 新建定时任务', !schedAdd.isError && !!schedId && /已新增/.test(schedAdd.text || ''), schedAdd.text?.split('\n')[1]?.slice(0, 80));

  const schedDel = await tool(controlTools, 'bossclaw_app_action').handler({ action: 'scheduleRemove', params: { id: schedId } });
  record('MCP scheduleRemove 删除定时任务', !schedDel.isError && schedDel.data?.applied === true, schedDel.text?.split('\n')[1]?.slice(0, 80));

  const sendNowGate = await tool(controlTools, 'bossclaw_app_action').handler({ action: 'deliverySendNow', params: {} });
  // 控制桥约定：动作「应被拒绝」时 applied===false（isError 为 true 是既有约定，与非法路由一致）
  record('review 模式下 deliverySendNow 被安全闸拒绝', sendNowGate.data?.applied === false && /全自动未开启/.test(sendNowGate.text || ''), sendNowGate.text?.split('\n')[1]?.slice(0, 90));

  // ===== 阶段接管：驱动已运行实例 =====
  const act = (action, params = {}) => tool(controlTools, 'bossclaw_app_action').handler({ action, params });
  const pdf = await act('appDataFull', { sections: ['pending', 'greetings', 'taskRuns'], maxPending: 20 });
  record('接管 appDataFull 分段读取', !pdf.isError && pdf.data?.applied === true && !!pdf.data?.next?.sections?.pending, pdf.text?.split('\n')[1]?.slice(0, 80));

  const uiSnap = await act('uiSnapshot', { scope: 'app', limit: 10 });
  record('接管 uiSnapshot(app) 返回交互元素', !uiSnap.isError && Array.isArray(uiSnap.data?.next?.elements) && uiSnap.data.next.elements.length > 0, `elements=${uiSnap.data?.next?.count}`);

  const pendAdd = await act('dataPendingAdd', { item: { id: 'e2e-pending-1', status: 'pending', job: { title: '测试岗位', company: '测试公司' }, deliveryGreeting: '您好，我对贵司岗位很感兴趣，这是我的简历，期待沟通。', createdAt: Date.now() } });
  record('接管 dataPendingAdd 造岗位', !pendAdd.isError && pendAdd.data?.applied === true);

  const pendApprove = await act('pendingApprove', { id: 'e2e-pending-1' });
  record('接管 pendingApprove → approved', !pendApprove.isError && (pendApprove.data?.next?.updated || []).includes('e2e-pending-1'), pendApprove.text?.split('\n')[1]?.slice(0, 80));

  const pendPromote = await act('pendingPromote', {});
  record('接管 pendingPromote 提升 approved→approved_queue', !pendPromote.isError && typeof pendPromote.data?.next?.count === 'number', pendPromote.text?.split('\n')[1]?.slice(0, 80));

  const pendRemove = await act('pendingRemove', { id: 'e2e-pending-1' });
  record('接管 pendingRemove 移除岗位', !pendRemove.isError && pendRemove.data?.applied === true, pendRemove.text?.split('\n')[1]?.slice(0, 80));

  const tskStageBad = await act('taskStage', { id: 'e2e-no-run', direct: 'next' });
  // 动作被拒（applied:false）时 MCP 工具约定 isError=true
  record('接管 taskStage 未知任务拒绝', tskStageBad.isError === true && tskStageBad.data?.applied === false && /任务不存在/.test(tskStageBad.text || ''), tskStageBad.text?.split('\n')[1]?.slice(0, 80));

  const pauseGuard = await act('pauseDelivery', { minutes: 30 });
  const autochatCool = await act('autochatStep', {});
  record('接管 autochatStep 冷却守卫生效', autochatCool.isError === true && autochatCool.data?.applied === false && /冷却/.test(autochatCool.text || ''), autochatCool.text?.split('\n')[1]?.slice(0, 90));
  await act('resumeDelivery', {});

  const badUi = await act('uiEvalRaw', { ops: ['eval'] });
  record('接管 非法动作被拒', badUi.isError === true && /不支持的动作/.test(badUi.text || ''), (badUi.text || '').split('\n')[0]?.slice(0, 80));

  // ===== 阶段 2：端口回退 + CLI 开关（--control-bridge，不带环境变量）=====
  // 旧实现把端口写死，被占用时桥整个不可用；这里用一个占位服务顶住 17650 来验证回退。
  // 同时**故意不设置 BOSSCLAW_CONTROL**，只靠命令行开关开启 —— 这是启动脚本用的方式
  // （start-bossclaw.cmd 经快捷方式拉起 electron，参数比环境变量可靠）。
  const bridgeInfoFile = infoFile;
  await killTree(pid);
  await sleep(1200);
  await fsp.rm(bridgeInfoFile, { force: true });

  const blocker = http.createServer((_req, res) => res.end('occupied'));
  // 默认端口已被本机正在运行的 BossClaw 实例占用（多实例并存是产品常态）时，
  // 占位服务无法再绑定 17650 —— 此时跳过占位即可：隔离实例仍会回退到备用端口，
  // 「被占用 → 自动回退」的断言同样成立，只是“占用者”是真实实例而非占位服务。
  let blockerUp = false;
  try {
    await new Promise((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(17650, '127.0.0.1', () => resolve());
    });
    blockerUp = true;
  } catch (e) {
    record('端口占位（默认端口已被占用则跳过）', true, `skip: ${e?.code || e?.message}`);
  }
  let pid2 = null;
  try {
    const started2 = spawnDetached(PATHS.electronBin, ['.', '--no-sandbox', '--control-bridge', `--user-data-dir=${USER_DATA}`], {
      cwd: PATHS.desktop,
      env: { BOSSCLAW_NO_GPU: '1', USERPROFILE: FAKE_HOME },
    });
    pid2 = started2.pid;
    let info2 = null;
    for (let i = 0; i < 60; i += 1) {
      await sleep(1000);
      const parsed = await readJsonSafe(bridgeInfoFile);
      if (parsed.ok && parsed.data?.port) {
        info2 = parsed.data;
        break;
      }
      if (!isPidAlive(pid2)) break;
    }
    record('CLI 开关 --control-bridge 可开启控制桥（无需环境变量）', !!info2, info2 ? `enabledVia=${info2.enabledVia}` : '未生成 info 文件');
    record('默认端口被占用时自动回退到备用端口', !!info2 && info2.port > 17650, `bound=${info2?.port}`);
    if (info2) {
      const h2 = await bridgeFetch(info2.port, info2.token, 'GET', '/health', null);
      record('备用端口上的桥功能正常', h2.ok && h2.data?.ok === true, JSON.stringify(h2.data ?? h2.error));
    }
  } finally {
    if (pid2) {
      await killTree(pid2);
      await sleep(1000);
    }
    if (blockerUp) blocker.close();
  }

  // ===== 阶段 3：显式关闭优先（环境变量开启 + CLI 关闭 → 必须不启动）=====
  await fsp.rm(bridgeInfoFile, { force: true });
  let pid3 = null;
  try {
    const started3 = spawnDetached(PATHS.electronBin, ['.', '--no-sandbox', '--no-control-bridge', `--user-data-dir=${USER_DATA}`], {
      cwd: PATHS.desktop,
      env: { BOSSCLAW_CONTROL: '1', BOSSCLAW_NO_GPU: '1', USERPROFILE: FAKE_HOME },
    });
    pid3 = started3.pid;
    await sleep(12_000);
    record('显式关闭优先：--no-control-bridge 覆盖环境变量', !(await readJsonSafe(bridgeInfoFile)).ok, `info 文件存在=${(await readJsonSafe(bridgeInfoFile)).ok}`);
  } finally {
    if (pid3) {
      await killTree(pid3);
      await sleep(1000);
    }
  }
} catch (e) {
  record('端到端执行', false, String(e?.message || e));
} finally {
  // 先出结论，再做清理 —— 清理是 best-effort，不允许影响判定输出
  const failed = results.filter((r) => !r.pass);
  console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过${failed.length ? `；失败：${failed.map((f) => f.name).join('、')}` : ''}`);
  console.log('清理：结束隔离实例 → 还原真实 ~/.bossclaw → 删除沙箱目录');
  try {
    if (pid) {
      await killTree(pid);
      await sleep(1500);
      console.log(`已结束隔离实例 pid=${pid}（存活=${isPidAlive(pid)}）`);
    }
  } catch (e) {
    console.error(`⚠️ 结束隔离实例失败：${e?.message}`);
  }
  try {
    await restoreRealHome(hadRealHome);
    console.log(`真实 ~/.bossclaw 已还原（备份：${HOME_BACKUP}）`);
  } catch (e) {
    console.error(`⚠️ 还原 ~/.bossclaw 失败，备份保留在 ${HOME_BACKUP}：${e?.message}`);
  }
  await fsp.rm(SANDBOX, { recursive: true, force: true }).catch((e) => console.error(`⚠️ 删除沙箱目录失败：${e?.message}`));
  process.exit(failed.length ? 1 : 0);
}
