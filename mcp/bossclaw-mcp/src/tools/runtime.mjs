// src/tools/runtime.mjs —— 运行控制工具组（启动 / 停止 / 状态 / 冒烟）
import path from 'node:path';
import { PATHS, DESKTOP_DIR, MODE, run, ok, fail, truncate, statSafe, probePort, tailTextFile, spawnDetached, killTree, isPidAlive, controlCall, resolveInstalledExe } from '../context.mjs';
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
      '默认启动目标跟随当前 MCP 目标形态：检测到已安装打包版（如 F:\\BOSSClaw\\BossClaw.exe）时启动安装版，否则启动开发目录 Electron。' +
      '也可用 installed:true / exe 参数显式指定安装版（自动带 --control-bridge），或 dev:true 强制开发目录。' +
      '自动清理沙箱注入的 NODE_OPTIONS / ELECTRON_RUN_AS_NODE / PYTHONPATH。返回 pid 与启动后存活状态。',
    annotations: WRITE_LOCAL,
    inputSchema: obj({
      control: bool('开启应用内控制桥（默认 true）', { default: true }),
      noGpu: bool('追加 BOSSCLAW_NO_GPU=1 并加 --no-sandbox（无 GPU / 沙箱环境用，默认 false）', { default: false }),
      dev: bool('以 --dev 模式启动（加载 Vite 5173 开发服务，需先跑 npm run dev）', { default: false }),
      installed: bool('启动已安装的打包版应用（自动探测 BossClaw.exe，如 F:\\BOSSClaw\\BossClaw.exe；找不到时可用 exe 参数显式指定）', { default: false }),
      exe: str('直接指定要启动的应用可执行文件路径（优先级最高，如 F:\\BOSSClaw\\BossClaw.exe）'),
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
            '未找到已安装的 BossClaw.exe。请用 exe 参数显式指定（如 F:\\BOSSClaw\\BossClaw.exe），' +
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
      const log = await tailLog(PATHS.logs.app, 15);

      const lines = [
        `启动命令：${cmd}（cwd=${mode === 'installed' ? path.dirname(exePath) : 'desktop-app'}）`,
        `pid=${pid}｜等待 ${waitSec}s 后：${alive ? '✅ 存活' : '❌ 已退出'}`,
        `进程数：${after.processes.length}（detect=${after.method}）`,
        after.warning ? `⚠️ ${after.warning}` : '',
        `控制桥：${bridge && bridge.ok ? `✅ 可用 :${bridge.data?.port || ''}（${JSON.stringify(bridge.data || {})}）` : args.control === false ? '未启用（本次未开启）' : `❌ 未就绪 ${bridge?.error || ''}`}`,
        mode === 'installed'
          ? `启动目标：${exePath}（安装版打包应用）`
          : `dist 产物：${(await statSafe(path.join(PATHS.distDir, 'index.html'))).exists ? '存在' : '缺失（生产模式会白屏，请先 bossclaw_build）'}`,
        log ? `\n最近日志（${path.basename(log.file)}）：\n${log.lines.slice(-10).join('\n')}` : '',
      ];
      const data = { pid, cmd, mode, exe: exePath, alive, processCount: after.processes.length, bridge: bridge?.data || null, logTail: log?.lines || [] };
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

  {
    name: 'bossclaw_smoke',
    title: 'Electron 冒烟测试',
    description:
      '在受限窗口内启动 Electron 主进程并观察其是否存活（存活到超时=正常，提前退出=异常），随后整棵结束进程。' +
      '用于验证主进程改动没有引入启动期崩溃 / 白屏。会读取应用日志尾部辅助定位。',
    annotations: WRITE_LOCAL,
    inputSchema: obj({
      timeoutSec: num('观察窗口秒数（默认 20）', { default: 20 }),
      noGpu: bool('追加 --no-sandbox 与 BOSSCLAW_NO_GPU=1（无 GPU / 沙箱环境，默认 true）', { default: true }),
      control: bool('同时开启控制桥（默认 false，避免侧效应）', { default: false }),
    }),
    handler: async (args = {}) => {
      if (!(await statSafe(PATHS.electronBin)).exists) return fail(`未找到 Electron：${PATHS.electronBin}`);
      const distIndex = await statSafe(path.join(PATHS.distDir, 'index.html'));
      const before = await listBossclawProcesses();
      if (before.processes.length) {
        const killed = before.processes.map((p) => p.pid);
        for (const pid of killed) await killTree(pid);
        await sleep(1000);
      }

      const env = {};
      if (args.noGpu !== false) env.BOSSCLAW_NO_GPU = '1';
      if (args.control) env.BOSSCLAW_CONTROL = '1';
      const argv = ['.', ...(args.noGpu !== false ? ['--no-sandbox'] : [])];
      const timeoutSec = Math.min(Math.max(Number(args.timeoutSec) || 20, 5), 120);
      const t0 = Date.now();
      const res = await run(PATHS.electronBin, argv, { cwd: DESKTOP_DIR, env, timeoutMs: timeoutSec * 1000 });
      const survived = res.timedOut; // 观察窗口内一直存活
      const log = await tailLog(PATHS.logs.app, 30);

      const lines = [
        `冒烟结果：${survived ? `✅ 存活至 ${timeoutSec}s 观察窗口结束（正常）` : `❌ 提前退出（退出码 ${res.code}，${Date.now() - t0}ms）`}`,
        `命令：${res.cmd}（cwd=desktop-app）`,
        `dist/index.html：${distIndex.exists ? `存在（${distIndex.mtime}）` : '缺失 → 生产模式会白屏，请先 bossclaw_build'}`,
        res.stdout.trim() ? `\n--- stdout 尾部 ---\n${truncate(res.stdout.slice(-3000), 3000)}` : '',
        res.stderr.trim() ? `\n--- stderr 尾部 ---\n${truncate(res.stderr.slice(-3000), 3000)}` : '',
        log ? `\n--- ${path.basename(log.file)} 尾部 ---\n${log.lines.slice(-12).join('\n')}` : '',
      ].filter(Boolean);

      const data = { survived, code: res.code, durationMs: Date.now() - t0, distExists: distIndex.exists, stderrTail: res.stderr.slice(-3000) };
      return survived ? ok(lines.join('\n'), data) : fail(lines.join('\n'), data);
    },
  },
];
