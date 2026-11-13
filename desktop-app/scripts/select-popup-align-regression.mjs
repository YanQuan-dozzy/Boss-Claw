// antd Select 弹层对齐兜底回归（issue #13）
//
// 为什么需要它：#13 的故障不抛错、不报类型问题，唯一可见信号是弹层 DOM 一直停在
// rc-trigger 的默认定位 `left:-1000vw; top:-1000vh`。兜底逻辑是纯 DOM 判定 + 补发 resize，
// 一旦判定条件写错（比如把「已对齐」判成「未对齐」），就会每次打开下拉都往全局广播 resize，
// 把无关的 resize 监听（侧边栏断点、页面测量）也一起惊动。类型系统看不见这种错，必须断言。
//
// 做法：用 esbuild 把 antdPopupAlignGuard.ts 打成临时 CJS 再 require（与 cooldown-regression 同款），
// 用假的 Document/Popup 验证判定与补发次数；真实 window/MutationObserver 由安装函数内部兜底。
//
// 用法：node scripts/select-popup-align-regression.mjs   （EXIT 0 = 全通过，1 = 有失败）
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

async function load() {
  const dir = mkdtempSync(join(tmpdir(), 'bossclaw-popup-align-'));
  const outfile = join(dir, 'bundle.cjs');
  await build({
    stdin: { contents: "export * from './src/lib/antdPopupAlignGuard.ts';", resolveDir: root, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'silent',
  });
  const m = require(outfile);
  return { m, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

const { m: G, cleanup } = await load();

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? '  → ' + detail : ''));
}

const popup = (left, top, connected = true) => ({ style: { left, top }, isConnected: connected });
const docWith = (popups) => ({ querySelectorAll: () => popups });

// ===== A. 单弹层判定：只有「左右都停在默认位置」才算未对齐 =====
{
  ok('默认位置（-1000vw/-1000vh）判为未对齐', G.isPopupUnpositioned(popup('-1000vw', '-1000vh')));
  ok(
    '真实 DOM 像素值（-14400px/-9000px）判为未对齐',
    G.isPopupUnpositioned(popup('-14400px', '-9000px'), { width: 1440, height: 900 }),
  );
  ok('已对齐（px 值）判为正常', !G.isPopupUnpositioned(popup('1017px', '108px'), { width: 1440, height: 900 }));
  ok('仅 left 为默认值不算（half 状态不误判）', !G.isPopupUnpositioned(popup('-1000vw', '0px')));
  ok('仅 top 为默认值不算', !G.isPopupUnpositioned(popup('0px', '-1000vh')));
  ok('空 style 不算', !G.isPopupUnpositioned({ style: {} }));
}

// ===== B. 多弹层：任意一个可见弹层未对齐都必须触发 =====
{
  ok('单个未对齐弹层 → 命中', G.hasStuckSelectPopup(docWith([popup('-1000vw', '-1000vh')])));
  ok('全部已对齐 → 不命中', !G.hasStuckSelectPopup(docWith([popup('12px', '34px'), popup('56px', '78px')])));
  ok('混合时只要有一个未对齐 → 命中', G.hasStuckSelectPopup(docWith([popup('12px', '34px'), popup('-1000vw', '-1000vh')])));
  ok('没有弹层 → 不命中', !G.hasStuckSelectPopup(docWith([])));
  ok('未对齐但已脱离文档 → 不命中（补发 resize 不会让它对齐）', !G.hasStuckSelectPopup(docWith([popup('-1000vw', '-1000vh', false)])));
}

// ===== C. 补发动作：仅在命中时调用一次，健康路径必须零副作用 =====
{
  let dispatched = 0;
  const healthy = G.rescueStuckSelectPopups(docWith([popup('12px', '34px')]), () => { dispatched += 1; });
  ok('健康弹层不补发 resize', healthy === false && dispatched === 0, `dispatched=${dispatched}`);

  const stuck = G.rescueStuckSelectPopups(docWith([popup('-1000vw', '-1000vh')]), () => { dispatched += 1; });
  ok('未对齐弹层补发且只补发一次', stuck === true && dispatched === 1, `dispatched=${dispatched}`);
}

// ===== D. 接线守卫：兜底必须在应用启动时安装，且只关注「可见」弹层 =====
{
  const main = readFileSync(join(root, 'src', 'main.tsx'), 'utf8');
  ok('main.tsx 安装了对齐兜底', /installAntdPopupAlignGuard\(\)/.test(main));
  ok('选择器排除了 -hidden 关闭态弹层', /:not\(\.ant-select-dropdown-hidden\)/.test(G.VISIBLE_SELECT_POPUP_SELECTOR || ''));
  ok('选择器限定 Select 弹层', /\.ant-select-dropdown/.test(G.VISIBLE_SELECT_POPUP_SELECTOR || ''));
}

cleanup();

console.log('[Select 弹层对齐回归] 通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
  for (const f of fails) console.log('  FAIL  ' + f);
  process.exit(1);
}
