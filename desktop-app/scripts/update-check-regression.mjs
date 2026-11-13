// 版本更新检查（src/lib/bossclaw/updateCheck.ts）回归断言（零新增依赖）
//
// 为什么需要它：版本比较是最容易「看起来对、实际错」的一类代码 ——
//   · 用字符串比较时 "2.10.0" < "2.9.0"（字典序），会把新版本判成旧版本，用户永远收不到更新提示；
//   · 解析不出三段号时若默认返回「有新版本」，会在接口返回异常时反复骚扰用户；
//   · 相等 / 降级必须判 false，否则每次检查都提示「发现新版本 v2.6.1」。
// 这些都不会被 typecheck 与构建发现（构建只保证类型对，不保证语义对）。
//
// 做法：沿用项目惯例，用已有 esbuild 把 TS 打成临时 CJS 再 require；
// `@/lib/electronApi` 用桩替换，从而离线跑通（不发任何真实网络请求）。
//
// 用法：node scripts/update-check-regression.mjs   （EXIT 0 = 全通过，1 = 有失败）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// electronApi 桩：记录 fetchUrl 调用次数，供「缓存命中不再请求」断言使用
const stubPlugin = {
  name: 'stub-electron-api',
  setup(b) {
    b.onResolve({ filter: /electronApi$/ }, () => ({ path: 'stub-electron-api', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      loader: 'js',
      contents: [
        'export const electronApi = globalThis.__electronApi;',
      ].join('\n'),
    }));
  },
};

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass += 1; return; }
  failures.push(`${name}\n    期望 ${e}\n    实际 ${a}`);
}
function ok(name, cond, detail) {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? '\n    ' + detail : ''}`);
}

const dir = mkdtempSync(join(tmpdir(), 'bossclaw-update-'));
const outfile = join(dir, 'updateCheck.cjs');

try {
  // 最小 localStorage 桩：updateCheck 用它做 6 小时缓存
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  globalThis.__electronApi = {
    getAppInfo: async () => ({ name: 'BossClaw', version: '2.6.1' }),
    fetchUrl: async (url) => {
      globalThis.__fetchCount = (globalThis.__fetchCount || 0) + 1;
      globalThis.__lastUrl = url;
      return globalThis.__fetchResult || { ok: false, error: 'offline' };
    },
    external: { open: () => { globalThis.__openedUrl = 'called'; } },
  };

  await build({
    entryPoints: [join(root, 'src', 'lib', 'bossclaw', 'updateCheck.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile,
    logLevel: 'silent',
    plugins: [stubPlugin],
  });

  const require_ = createRequire(import.meta.url);
  const m = require_(outfile);

  // ===== 1. 版本号解析 =====
  check('parseVersion(v2.6.1)', m.parseVersion('v2.6.1'), [2, 6, 1]);
  check('parseVersion( 2.6.1 )', m.parseVersion(' 2.6.1 '), [2, 6, 1]);
  check('parseVersion(2.6) 不完整 → []', m.parseVersion('2.6'), []);
  check('parseVersion(abc) → []', m.parseVersion('abc'), []);
  check('parseVersion(v10.20.30) 多位数', m.parseVersion('v10.20.30'), [10, 20, 30]);
  check('parseVersion(2.6.1-beta.2) 取前三位', m.parseVersion('2.6.1-beta.2'), [2, 6, 1]);

  // ===== 2. 版本比较（核心：不能用字符串比较）=====
  check('2.10.0 > 2.9.0', m.isNewerVersion('2.10.0', '2.9.0'), true);
  check('2.9.0 < 2.10.0', m.isNewerVersion('2.9.0', '2.10.0'), false);
  check('相等 → false', m.isNewerVersion('2.6.1', '2.6.1'), false);
  check('降级 → false', m.isNewerVersion('2.6.0', '2.6.1'), false);
  check('带 v 前缀', m.isNewerVersion('v2.7.0', '2.6.1'), true);
  check('主版本升级', m.isNewerVersion('3.0.0', '2.99.99'), true);
  check('解析失败 → false（宁可不提示，也不误报）', m.isNewerVersion('abc', '2.6.1'), false);
  check('当前版本解析失败 → false', m.isNewerVersion('2.7.0', 'unknown'), false);

  // ===== 3. 检查流程 =====
  // 3.1 读到新版本号
  globalThis.__fetchResult = {
    ok: true,
    status: 200,
    text: JSON.stringify({
      tag_name: 'v2.7.0',
      html_url: 'https://github.com/YanQuan-dozzy/Boss-Claw/releases/tag/v2.7.0',
      published_at: '2026-11-01T00:00:00Z',
    }),
  };
  const r1 = await m.checkForUpdates(true);
  ok('有更新：ok=true', r1.ok === true, JSON.stringify(r1));
  check('有更新：latest 去掉 v 前缀', r1.latest, '2.7.0');
  check('有更新：hasUpdate=true', r1.hasUpdate, true);
  check('有更新：取 html_url', r1.url, 'https://github.com/YanQuan-dozzy/Boss-Claw/releases/tag/v2.7.0');
  ok('有更新：请求的是 releases/latest 接口', String(globalThis.__lastUrl).endsWith('/releases/latest'), String(globalThis.__lastUrl));

  // 3.2 同版本 → 不提示更新
  globalThis.__fetchResult = { ok: true, status: 200, text: JSON.stringify({ tag_name: 'v2.6.1' }) };
  const r2 = await m.checkForUpdates(true);
  check('同版本：hasUpdate=false', r2.hasUpdate, false);

  // 3.3 网络失败 → ok:false 且带可读 error（不抛异常）
  globalThis.__fetchResult = { ok: false, error: 'ECONNRESET' };
  const r3 = await m.checkForUpdates(true);
  ok('网络失败：ok=false', r3.ok === false, JSON.stringify(r3));
  ok('网络失败：error 含原因', String(r3.error || '').includes('ECONNRESET'), String(r3.error));

  // 3.4 GitHub 限流（返回 message 无 tag_name）→ 不当作新版本
  globalThis.__fetchResult = { ok: true, status: 403, text: JSON.stringify({ message: 'API rate limit exceeded' }) };
  const r4 = await m.checkForUpdates(true);
  ok('限流：ok=false', r4.ok === false, JSON.stringify(r4));
  ok('限流：error 带 GitHub 原文', String(r4.error || '').includes('rate limit'), String(r4.error));

  // 3.5 缓存：force=false 时命中缓存不再请求
  globalThis.__fetchResult = { ok: true, status: 200, text: JSON.stringify({ tag_name: 'v2.8.0' }) };
  const r5 = await m.checkForUpdates(true);   // 写入缓存（v2.8.0）
  const before = globalThis.__fetchCount;
  const r6 = await m.checkForUpdates(false);  // 应直接读缓存
  check('缓存：不再发请求', globalThis.__fetchCount, before);
  check('缓存：内容与首次一致', r6.latest, r5.latest);
  ok('缓存：命中时带 checkedAt', typeof r6.checkedAt === 'number', String(r6.checkedAt));

  // ===== 4. 每日自动检查（进入应用时触发） =====
  const AUTO_KEY = 'bossclaw-update-auto-check-day';
  const today = (() => {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${dd}`;
  })();

  // 4.1 当天首次进入：真正检查一次并写「已检查日」
  store.delete(AUTO_KEY);
  globalThis.__fetchResult = { ok: true, status: 200, text: JSON.stringify({ tag_name: 'v2.9.0' }) };
  const beforeDaily = globalThis.__fetchCount;
  const d1 = await m.checkForUpdatesDaily();
  ok('每日检查：首次返回结果', d1 && d1.ok === true, JSON.stringify(d1));
  check('每日检查：hasUpdate=true', d1 && d1.hasUpdate, true);
  check('每日检查：发出一次请求', globalThis.__fetchCount, beforeDaily + 1);
  check('每日检查：写入当天标记', store.get(AUTO_KEY), today);

  // 4.2 同日再次进入：不请求、返回 null（不重复提示）
  const beforeSecond = globalThis.__fetchCount;
  const d2 = await m.checkForUpdatesDaily();
  check('每日检查：同日第二次返回 null', d2, null);
  check('每日检查：同日第二次不再请求', globalThis.__fetchCount, beforeSecond);

  // 4.3 跨天（清标记模拟新的一天）：再次真正检查
  store.delete(AUTO_KEY);
  const beforeNextDay = globalThis.__fetchCount;
  const d3 = await m.checkForUpdatesDaily();
  ok('每日检查：跨天重新检查', d3 && d3.ok === true, JSON.stringify(d3));
  check('每日检查：跨天发出一次请求', globalThis.__fetchCount, beforeNextDay + 1);

  // 4.4 读不到当前版本：不占当天额度（本次不请求，标记清空，下次启动重试）
  store.delete(AUTO_KEY);
  const originalGetAppInfo = globalThis.__electronApi.getAppInfo;
  globalThis.__electronApi.getAppInfo = async () => ({});
  const beforeNoVersion = globalThis.__fetchCount;
  const d4 = await m.checkForUpdatesDaily();
  check('每日检查：读不到版本返回 null', d4, null);
  check('每日检查：读不到版本不发请求', globalThis.__fetchCount, beforeNoVersion);
  check('每日检查：读不到版本不占当天额度', store.get(AUTO_KEY) || '', '');
  globalThis.__electronApi.getAppInfo = originalGetAppInfo;

  // 4.5 网络失败：仍占用当天额度（避免一天内反复联网）
  store.delete(AUTO_KEY);
  globalThis.__fetchResult = { ok: false, error: 'offline' };
  const d5 = await m.checkForUpdatesDaily();
  ok('每日检查：网络失败返回 ok=false', d5 && d5.ok === false, JSON.stringify(d5));
  check('每日检查：失败也记当天标记', store.get(AUTO_KEY), today);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 偶发占用，忽略 */ }
}

if (failures.length) {
  console.error(`\n[更新检查回归] 通过 ${pass} 项，失败 ${failures.length} 项`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`[更新检查回归] 通过 ${pass} 项，失败 0 项`);
