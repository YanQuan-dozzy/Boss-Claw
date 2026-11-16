// notify-reply-regression.mjs —— 「HR 回复提醒」（P1-4）回归断言
//
// 为什么需要它：AI 跟聊会自动回复 HR 消息，但用户完全不知道「HR 回了什么」。
// 本功能的价值与风险都在「提醒的克制程度」上 —— 提醒多了就是骚扰，少了等于没做：
//   · 同一会话 10 分钟内只提醒一次（跟聊监听两分钟一轮，HR 连发多条会刷屏）；
//   · HR 明确拒绝必须立刻提醒且文案不同（终态，绕过聚合）；
//   · 两层开关：systemNotify（主）+ hrReplyNotify（子），任一层关掉都不发；
//   · 点击通知要能跳回跟聊页并高亮该会话 —— 这条链路跨主进程 / preload / 渲染层，最易断。
//
// 这些都不在 typecheck / build 的覆盖范围内（类型只保证函数存在，不保证聚合行为与接线完整），
// 所以在这里钉住：前半段跑真实 notify.ts 的运行时行为，后半段对源码做结构守卫。
//
// 用法：node scripts/notify-reply-regression.mjs   （EXIT 0 = 全通过，1 = 有失败）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

// ===== 最小浏览器环境（notify.ts 依赖 window.electron 与 settings store 的 localStorage 持久化）=====
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i) => Array.from(mem.keys())[i] ?? null,
  get length() { return mem.size; },
};
/** 捕获渲染层发出的通知（主进程侧行为不在本脚本覆盖范围，另有源码守卫） */
const sent = [];
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  setTimeout, clearTimeout,
  electron: {
    notify: async (payload) => { sent.push(payload); return { ok: true }; },
  },
};
globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; return; }
  fails.push(name + (detail ? '  → ' + detail : ''));
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}

const dir = mkdtempSync(join(tmpdir(), 'bossclaw-notify-'));
const outfile = join(dir, 'bundle.cjs');
const realNow = Date.now;
let mod;
try {
  await build({
    stdin: {
      contents: [
        "export { notifyHrReply, hrReplyNotifyEnabled, hrReplyConvKey, resetHrReplyNotifyState, HR_REPLY_AGGREGATE_MS } from './src/lib/notify.ts';",
        "export { useSettingsStore } from './src/store/useSettingsStore.ts';",
        "export { DEFAULT_CONFIG } from './src/lib/bossclaw/defaults.ts';",
      ].join('\n'),
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'silent',
    alias: { '@': join(root, 'src') },
  });
  mod = require(outfile);

  const {
    notifyHrReply, hrReplyNotifyEnabled, hrReplyConvKey, resetHrReplyNotifyState,
    HR_REPLY_AGGREGATE_MS, useSettingsStore, DEFAULT_CONFIG,
  } = mod;

  // ===== 时间夹具：聚合是「时间 - 上次提醒」判定，必须能推进时钟（不能靠 sleep 10 分钟）=====
  let fakeNow = 1_700_000_000_000;
  Date.now = () => fakeNow;

  /** 每个用例都从干净状态开始：默认配置 + 清空聚合表 + 清空发出的通知 */
  const reset = (patch = {}) => {
    useSettingsStore.setState({ config: { ...DEFAULT_CONFIG, ...patch } });
    resetHrReplyNotifyState();
    sent.length = 0;
    fakeNow += 60 * 60 * 1000; // 每个用例换一个小时刻度，避免跨用例残留
  };

  const baseArgs = {
    convKey: hrReplyConvKey('张丽', '某某科技有限公司'),
    conversation: '张丽',
    jobTitle: '前端开发工程师',
    hrName: '张丽',
    hrMessage: '你好，方便发一份简历吗？',
  };

  // ===== A. 默认值 =====
  eq('默认开启 HR 回复提醒（默认关掉等于没做）', DEFAULT_CONFIG.hrReplyNotify, true);
  reset();
  eq('配置读取：默认值下 hrReplyNotifyEnabled() 为真', hrReplyNotifyEnabled(), true);

  // ===== B. 基本提醒 =====
  reset();
  eq('检测到 HR 新消息 → 发出通知', notifyHrReply(baseArgs), true);
  eq('一次调用只发一条', sent.length, 1);
  eq('标题固定为「HR 新消息」', sent[0]?.title, 'HR 新消息');
  ok('正文带「岗位 · HR 名：消息预览」',
    String(sent[0]?.body || '').includes('前端开发工程师 · 张丽：你好，方便发一份简历吗？'),
    JSON.stringify(sent[0]?.body));
  eq('点击动作 = open-autochat', sent[0]?.clickAction?.kind, 'open-autochat');
  eq('点击动作为空串是缺陷（无法高亮会话）',
    sent[0]?.clickAction?.conversation, '张丽');

  // ===== C. 会话聚合 =====
  reset();
  for (let i = 0; i < 5; i += 1) notifyHrReply({ ...baseArgs, hrMessage: `第 ${i + 1} 条消息` });
  eq('同一会话连发 5 条 → 只提醒 1 次', sent.length, 1);

  reset();
  const other = { ...baseArgs, convKey: hrReplyConvKey('王强', '另一家公司'), conversation: '王强', hrName: '王强' };
  notifyHrReply(baseArgs);
  notifyHrReply(other);
  eq('不同会话各提醒一次（聚合键不能退化成全局）', sent.length, 2);

  reset();
  notifyHrReply(baseArgs);
  fakeNow += HR_REPLY_AGGREGATE_MS - 1000;
  notifyHrReply(baseArgs);
  eq('距上次提醒不足 10 分钟 → 不再提醒', sent.length, 1);
  fakeNow += 2000; // 越过 10 分钟窗口
  notifyHrReply(baseArgs);
  eq('超过 10 分钟 → 会话可再次提醒', sent.length, 2);

  // ===== D. HR 明确拒绝（终态）=====
  reset();
  notifyHrReply(baseArgs);
  eq('拒绝用例前置：普通提醒已发出', sent.length, 1);
  eq('拒绝提醒绕过 10 分钟聚合（终态必须立刻可见）', notifyHrReply({ ...baseArgs, rejected: true }), true);
  eq('拒绝会额外发一条', sent.length, 2);
  ok('拒绝文案与「新消息」可区分',
    String(sent[1]?.title || '').includes('拒绝') && sent[1]?.title !== 'HR 新消息',
    JSON.stringify(sent[1]?.title));
  ok('拒绝正文仍带 HR 消息预览（用户要知道拒在哪一句）',
    String(sent[1]?.body || '').includes('方便发一份简历'));
  eq('拒绝通知也带点击动作（点开仍能回到该会话）', sent[1]?.clickAction?.kind, 'open-autochat');

  // ===== E. 两层开关 =====
  reset({ systemNotify: false });
  eq('主开关关 → 不发', notifyHrReply(baseArgs), false);
  eq('主开关关 → 一条都没有', sent.length, 0);

  reset({ hrReplyNotify: false });
  eq('子开关关 → 不发', notifyHrReply(baseArgs), false);
  eq('子开关关 → 一条都没有', sent.length, 0);

  reset({ systemNotify: true, hrReplyNotify: true });
  eq('两层都开 → 正常发', notifyHrReply(baseArgs), true);

  // ===== F. 边界 =====
  reset();
  eq('会话键为空 → 不发（避免所有会话挤成一条聚合）', notifyHrReply({ ...baseArgs, convKey: '' }), false);
  eq('会话键只有空白 → 不发', notifyHrReply({ ...baseArgs, convKey: '   ' }), false);
  eq('空会话键不应被计入聚合', sent.length, 0);

  reset();
  notifyHrReply({ ...baseArgs, hrMessage: '很长的消息'.repeat(30) });
  ok('预览截断到 40 字（通知正文不能整段灌进来）',
    String(sent[0]?.body || '').length < 40 + 20 && String(sent[0]?.body || '').includes('很长的消息'));
  ok('预览不超过 40 个字符', String(sent[0]?.body || '').split('：').pop().length <= 40);

  reset();
  notifyHrReply({ ...baseArgs, hrMessage: '', rejected: true });
  ok('拒绝但未提供消息时给占位文案，不留空正文', String(sent[0]?.body || '').trim().length > 0);

  // 会话键归一：空白与大小写差异必须归到同一条，否则「同一个 HR」会被拆成两个会话反复提醒
  eq('会话键归一：空白差异', hrReplyConvKey(' 张 丽 ', '某 某 科技'), hrReplyConvKey('张丽', '某某科技'));
  eq('会话键归一：英文大小写', hrReplyConvKey('Amy', 'ACME'), hrReplyConvKey('amy', 'acme'));
  eq('会话键归一：HR 名与公司都有区分度', hrReplyConvKey('张丽', 'A公司') === hrReplyConvKey('张丽', 'B公司'), false);
} finally {
  Date.now = realNow;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }
}

// ===== G. 接线守卫（跨进程链路，运行时用例覆盖不到）=====
const read = (rel) => readFileSync(join(root, rel), 'utf8');

try {
  const store = read('src/store/useAutoChatStore.ts');
  ok('跟聊收口点导入了 notifyHrReply', /import\s*\{[^}]*notifyHrReply[^}]*\}\s*from\s*'@\/lib\/notify'/.test(store));
  eq('批量链路与监听链路各有一个「新消息」提醒点', (store.match(/notifyHrReply\(notifyBase\)/g) || []).length, 2);
  eq('两条链路各有一个「明确拒绝」提醒点', (store.match(/notifyHrReply\(\{\s*\.\.\.notifyBase,\s*rejected:\s*true\s*\}\)/g) || []).length, 2);
  ok('提醒参数用 hrReplyConvKey 聚合（不是临时拼字符串）', (store.match(/convKey:\s*hrReplyConvKey\(/g) || []).length >= 2);
  ok('通知不参与业务判断：返回值未被用作分支条件', !/if\s*\(\s*!?notifyHrReply\(/.test(store));

  const main = read('electron/main.cjs');
  ok('主进程通知函数接受 clickAction', /function showSystemNotification\(title, body, clickAction\)/.test(main));
  ok('通知点击会回传 jc:notify-action', /webContents\.send\('jc:notify-action'/.test(main));
  ok('窗口仍在加载时等 did-finish-load（否则动作静默丢失）', /did-finish-load/.test(main));
  ok('jc:notify 把 clickAction 透传给通知函数',
    /showSystemNotification\(payload\?\.title,\s*payload\?\.body,\s*payload\?\.clickAction\)/.test(main));

  const preload = read('electron/preload/app.cjs');
  ok('IPC 白名单包含 jc:notify-action', /'jc:notify-action'/.test(preload));
  ok('preload 暴露 onNotifyAction 订阅', /onNotifyAction:\s*\(callback\)/.test(preload));

  const app = read('src/App.tsx');
  ok('渲染层订阅通知动作', /onNotifyAction\?\.\(/.test(app));
  ok('open-autochat 动作跳到跟聊页', /kind\s*!==\s*'open-autochat'/.test(app) && /setRoute\('autochat'\)/.test(app));
  ok('同时聚焦会话', /focusConversation\(/.test(app));

  const page = read('src/pages/AutoChat.tsx');
  ok('跟聊页读 conversationFocus', /conversationFocus/.test(page));
  ok('命中会话加 is-focus 高亮', /is-focus/.test(page));
  ok('聚焦后滚动到该卡', /scrollIntoView/.test(page));
  ok('高亮会自动撤掉（否则被当成运行态高亮）', /clearConversationFocus/.test(page));
  // 已沟通岗位默认从队列收起（避免堆积）；通知一定来自已沟通会话，
  // 聚焦前若不展开，高亮目标不在 DOM 里，点击通知会看起来「没反应」。
  ok('通知聚焦时自动展开已沟通列表', /setShowSent\(true\)/.test(page));

  const settings = read('src/pages/Settings.tsx');
  ok('设置页有「HR 回复提醒」子开关', /hrReplyNotify/.test(settings));
  ok('主开关关闭时子开关置灰', /disabled=\{config\.systemNotify === false\}/.test(settings));

  const defaults = read('src/lib/bossclaw/defaults.ts');
  ok('默认值里明确写了 hrReplyNotify: true', /hrReplyNotify:\s*true/.test(defaults));
} catch (e) {
  fails.push('接线守卫读取源码失败 → ' + String((e && e.message) || e));
}

if (fails.length) {
  console.error(`❌ notify-reply-regression：${fails.length} 项失败 / ${pass} 项通过`);
  for (const f of fails) console.error('  · ' + f);
  process.exit(1);
}
console.log(`✅ notify-reply-regression：${pass} 项全部通过`);
