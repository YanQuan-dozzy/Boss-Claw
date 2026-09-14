// src/tools/runtime.mjs —— 运行控制工具组（启动 / 停止 / 状态）
import path from 'node:path';
import { PATHS, DESKTOP_DIR, MODE, ok, fail, statSafe, probePort, tailTextFile, spawnDetached, killTree, isPidAlive, controlCall, resolveInstalledExe } from '../context.mjs';
import { obj, str, num, bool, arr, WRITE_LOCAL, READ_ONLY } from '../schema.mjs';
import { listBossclawProcesses } from '../procs.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tailLog(file, lines = 25) {
  const t = await tailTextFile(file, { lines });
  return t.exists ? { file: t.file, mtime: t.mtime, size: t.size, lines: t.lines } : null;
}

export const runtimeTools = [
  {
    name: 'bossclaw_app_start',
    title: '启动 BossClaw 应用',
    description:
      '启动桌面应用（默认同时开启应用内控制桥 BOSSCLAW_CONTROL=1，供 bossclaw_app_state / bossclaw_app_action 使用）。' +
      '默认启动目标跟随当前 MCP 目标形态：检测到已安装打包版（如 <安装目录>\\BossClaw.exe）时启动安装版，否则启动开发目录 Electron。' +
      '也可用 installed:true / exe 参数显式指定安装版（自动带 --control-bridge），或 dev:true 强制开发目录。' +
      '自动清理沙箱注入的 NODE_OPTIONS / ELECTRON_RUN_AS_NODE / PYTHONPATH。返回 pid 与启动后存活状态。' +
      '启动后还会经控制桥确认窗口可见：若窗口在 Win32 层处于隐藏状态（任务栏不出现应用图标），将自动 focusWindow 强制显示。',
    annotations: WRITE_LOCAL,
    inputSchema: obj({
      control: bool('开启应用内控制桥（默认 true）', { default: true }),
      noGpu: bool('追加 BOSSCLAW_NO_GPU=1 并加 --no-sandbox（无 GPU / 沙箱环境用，默认 false）', { default: false }),
      dev: bool('以 --dev 模式启动（加载 Vite 5173 开发服务，需先跑 npm run dev）', { default: false }),
      installed: bool('启动已安装的打包版应用（自动探测 BossClaw.exe，如 <安装目录>\\BossClaw.exe；找不到时可用 exe 参数显式指定）', { default: false }),
      exe: str('直接指定要启动的应用可执行文件路径（优先级最高，如 <安装目录>\\BossClaw.exe）'),
      extraArgs: arr('追加给 electron 的命令行参数'),
      waitSec: num('启动后等待秒数再判定存活（默认 8）', { default: 8 }),
      force: bool('已有实例在运行时先强制结束再启动（默认 false）', { default: false }),
    }),
    handler: async (args = {}) => {
      let exePath = PATHS.electronBin;
      let cwd = DESKTOP_DIR;
      // 默认启动目标跟随当前 MCP 目标形态：installed → 安装版 BossClaw.exe；dev/custom → 开发目录 Electron
      let mode = MODE === 'installed' ? 'installed' : 'dev';
      if (args.exe) {
        exePath = String(args.exe).trim();
        cwd = path.dirname(exePath);
        mode = 'installed';
      } else if (args.installed) {
        exePath = await resolveInstalledExe();
        if (!exePath) {
          return fail(
            '未找到已安装的 BossClaw.exe。请用 exe 参数显式指定（如 <安装目录>\\BossClaw.exe），' +
              '或设置 BOSSCLAW_EXE 环境变量指向安装版可执行文件。'
          );
        }
        cwd = path.dirname(exePath);
        mode = 'installed';
      }
      if (!(await statSafe(exePath)).exists) {
        return fail(
          mode === 'dev'
            ? `未找到 Electron 可执行文件：${exePath}（请先在 desktop-app 下安装依赖）`
            : `指定的可执行文件不存在：${exePath}`
        );
      }
      const before = await listBossclawProcesses();
      if (before.processes.length && !args.force) {
        return ok(
          `已有 ${before.processes.length} 个 BossClaw 进程在运行（pid ${before.processes.map((p) => p.pid).join(', ')}）。\n` +
            `如需重启请传 force:true，或先用 bossclaw_app_stop 停止。`,
          { alreadyRunning: true, processes: before.processes }
        );
      }
      if (before.processes.length && args.force) {
        for (const p of before.processes) await killTree(p.pid);
        await sleep(1200);
      }

      const env = {};
      if (args.control !== false) env.BOSSCLAW_CONTROL = '1';
      if (args.noGpu) env.BOSSCLAW_NO_GPU = '1';
      // 安装版不传 '.'（打包 exe 自带应用路径，多余参数可能被 Chromium 当作 URL/开关处理）；
      // 控制桥通过 argv 传 --control-bridge（与 start-bossclaw.cmd 一致，参数比环境变量更可靠）
      const argv =
        mode === 'installed'
          ? [...(args.noGpu ? ['--no-sandbox'] : []), ...(args.control !== false ? ['--control-bridge'] : []), ...(args.extraArgs || [])]
          : ['.', ...(args.dev ? ['--dev'] : []), ...(args.noGpu ? ['--no-sandbox'] : []), ...(args.extraArgs || [])];
      const { pid, cmd } = spawnDetached(exePath, argv, { cwd, env });

      const waitSec = Math.min(Math.max(Number(args.waitSec) || 8, 1), 60);
      await sleep(waitSec * 1000);
      const alive = isPidAlive(pid);
      const after = await listBossclawProcesses();
      const bridge = args.control !== false ? await controlCall('GET', '/health', null, 3000) : null;

      // ===== 启动后固定显示窗口 =====
      // 背景：某些启动路径（如 MCP 拉起安装版）下进程与渲染层都正常，但窗口在 Win32 层保持隐藏
      // （win.isVisible()=false），任务栏不出现 BossClaw 图标。这里经控制桥查一次 windowState，
      // 不可见时调用 focusWindow（内部 restore+show+focus）强制显示并复查；桥尚未就绪时短重试。
      let windowInfo = null;
      let windowLine = '窗口：无法确认可见性（控制桥未就绪）';
      if (args.control !== false) {
        for (let attempt = 0; attempt < 4 && !windowInfo; attempt++) {
          const st = await controlCall('POST', '/action', { action: 'windowState', params: {} }, 8000);
          if (st.ok && st.data?.next) {
            const win = st.data.next;
            if (win.visible === true) {
              windowInfo = { visible: true, forced: false, focused: !!win.focused, attempt: attempt + 1 };
            } else {
              const fw = await controlCall('POST', '/action', { action: 'focusWindow', params: {} }, 8000);
              const verify = fw.ok ? await controlCall('POST', '/action', { action: 'windowState', params: {} }, 8000) : null;
              windowInfo = {
                visible: !!verify?.data?.next?.visible,
                forced: fw.ok,
                focused: !!verify?.data?.next?.focused,
                error: fw.ok ? undefined : fw.error,
                note: '窗口初始在 Win32 层隐藏（任务栏无图标），已自动 focusWindow 强制显示',
                attempt: attempt + 1,
              };
            }
          } else if (attempt < 3) {
            await sleep(1500);
          }
        }
      }
      if (windowInfo) {
        if (windowInfo.visible) {
          windowLine = windowInfo.forced ? `窗口：⚠️ 初始隐藏 → ✅ 已强制显示（focusWindow）` : `窗口：✅ 已确认可见（focused=${windowInfo.focused}）`;
        } else {
          windowLine = `窗口：❌ 初始隐藏且强制显示失败${windowInfo.error ? `（${windowInfo.error}）` : ''}`;
        }
      }

      const log = await tailLog(PATHS.logs.app, 15);

      const lines = [
        `启动命令：${cmd}（cwd=${mode === 'installed' ? path.dirname(exePath) : 'desktop-app'}）`,
        `pid=${pid}｜等待 ${waitSec}s 后：${alive ? '✅ 存活' : '❌ 已退出'}`,
        `进程数：${after.processes.length}（detect=${after.method}）`,
        after.warning ? `⚠️ ${after.warning}` : '',
        `控制桥：${bridge && bridge.ok ? `✅ 可用 :${bridge.data?.port || ''}（${JSON.stringify(bridge.data || {})}）` : args.control === false ? '未启用（本次未开启）' : `❌ 未就绪 ${bridge?.error || ''}`}`,
        windowLine,
        mode === 'installed'
          ? `启动目标：${exePath}（安装版打包应用）`
          : `dist 产物：${(await statSafe(path.join(PATHS.distDir, 'index.html'))).exists ? '存在' : '缺失（生产模式会白屏）'}`,
        log ? `\n最近日志（${path.basename(log.file)}）：\n${log.lines.slice(-10).join('\n')}` : '',
      ];
      const data = { pid, cmd, mode, exe: exePath, alive, processCount: after.processes.length, bridge: bridge?.data || null, window: windowInfo || null, logTail: log?.lines || [] };
      return alive ? ok(lines.filter(Boolean).join('\n'), data) : fail(lines.filter(Boolean).join('\n'), data);
    },
  },

  {
    name: 'bossclaw_app_stop',
    title: '停止 BossClaw 应用',
    description: '结束 BossClaw 的 Electron 进程（按进程树整棵结束，不影响其它 Electron 应用）。默认结束全部匹配进程。',
    annotations: WRITE_LOCAL,
    inputSchema: obj({
      pid: num('只结束指定 pid（默认结束全部 BossClaw 进程）'),
    }),
    handler: async (args = {}) => {
      const { processes, method, warning } = await listBossclawProcesses();
      const targets = args.pid ? processes.filter((p) => p.pid === Number(args.pid)) : processes;
      if (!targets.length) return ok(`没有检测到运行中的 BossClaw 进程。${warning ? `\n⚠️ ${warning}` : ''}`, { killed: [], warning: warning || null });
      for (const p of targets) await killTree(p.pid);
      await sleep(800);
      const after = await listBossclawProcesses();
      const killed = targets.map((t) => t.pid);
      const still = after.processes.map((p) => p.pid);
      const lines = [
        `已结束 pid：${killed.join(', ')}（detect=${method}）`,
        still.length ? `⚠️ 仍有残留进程：${still.join(', ')}` : '✅ 已全部退出',
      ];
      return still.length ? fail(lines.join('\n'), { killed, remaining: still }) : ok(lines.join('\n'), { killed, remaining: [] });
    },
  },

  {
    name: 'bossclaw_app_status',
    title: '应用运行状态',
    description: '查看应用是否运行、进程列表、控制桥可用性、Camoufox 桥端口（18767）与日志新鲜度。排查现场的第一步。',
    annotations: READ_ONLY,
    inputSchema: obj({}),
    handler: async () => {
      const { processes, method, bridge, warning } = await listBossclawProcesses();
      // 无关耗时操作全部并发，减少串行累加延迟：
      // 18767 端口探测 / 引擎状态文件 / cookie 文件 / 三个日志 stat 全部并行
      const [camoufoxUp, engineStat, cookieStat, logEntries] = await Promise.all([
        probePort(18767),
        statSafe(PATHS.engineState),
        statSafe(PATHS.camoufoxCookies),
        Promise.all(Object.entries(PATHS.logs).map(async ([k, f]) => [k, await statSafe(f)])),
      ]);
      const bridgeHealth = bridge && !bridge.stale ? await controlCall('GET', '/health', null, 3000) : null;
      const logs = Object.fromEntries(logEntries.map(([k, s]) => [k, { file: PATHS.logs[k], exists: s.exists, size: s.size, mtime: s.mtime }]));

      const lines = [
        `# 运行状态`,
        ``,
        `- 应用进程：${processes.length ? `${processes.length} 个（pid ${processes.slice(0, 5).map((p) => p.pid).join(', ')}，detect=${method}）` : '未运行'}`,
        warning ? `- ⚠️ ${warning}` : '',
        `- 控制桥：${bridge ? (bridge.stale ? `记录已失效（pid ${bridge.pid}）` : `:${bridge.port} ${bridgeHealth?.ok ? '✅ 健康' : `⚠️ ${bridgeHealth?.error || '无响应'}`}`) : '未开启'}`,
        `- Camoufox 桥（:18767）：${camoufoxUp ? '✅ 端口可达' : '未监听'}`,
        `- 引擎状态文件：${engineStat.exists ? `${PATHS.engineState}（${engineStat.mtime}）` : '不存在'}`,
        `- Camoufox Cookie：${cookieStat.exists ? `${PATHS.camoufoxCookies}（${cookieStat.mtime}）` : '不存在（需先扫码登录）'}`,
        ``,
        `日志新鲜度：`,
        ...Object.entries(logs).map(([k, v]) => `  - ${k}: ${v.exists ? `${v.mtime}（${v.size} 字节）` : '不存在'}`),
      ].filter(Boolean);
      const data = { running: processes.length > 0, processes, bridge, warning: warning || null, camoufoxPort: camoufoxUp, logs };
      return ok(lines.join('\n'), data);
    },
  },
];
