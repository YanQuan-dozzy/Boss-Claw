// src/server.mjs —— 极简 MCP（Model Context Protocol）stdio 服务骨架
// ---------------------------------------------------------------------------
// 手写 JSON-RPC 2.0 帧处理，避免引入 @modelcontextprotocol/sdk 依赖
// （仓库历史上 npm install 曾被 EBUSY 阻断，零依赖可保证服务永远可启动）。
// 协议要点：
//   - stdio 传输：每条消息一行 JSON，禁止内含换行，禁止向 stdout 写任何非协议内容
//   - 支持方法：initialize / notifications/initialized / ping / tools/list / tools/call
//     （另对 resources/list、prompts/list、logging/setLevel 做良性空响应，兼容探针式客户端）
import readline from 'node:readline';

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0];

export const SERVER_INFO = {
  name: 'bossclaw-mcp',
  title: 'BossClaw 项目操作 MCP',
  version: '1.0.0',
};

/** 所有日志走 stderr —— stdout 是协议通道，污染会导致客户端解析失败 */
export function log(...args) {
  const text = args
    .map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
    .join(' ');
  process.stderr.write(`[bossclaw-mcp] ${text}\n`);
}

const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
};

/**
 * @param {object} options
 * @param {Array} options.tools  工具定义数组：{ name, title, description, inputSchema, annotations?, handler }
 * @param {string} options.instructions 初始化时回给客户端的说明（会进入模型上下文）
 */
export function createServer({ tools, instructions }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  // ===== stdout 背压（审查 #37 · 批次 12）=====
  // `process.stdout` 对 MCP 客户端是**管道**（非 TTY），管道写满时 `write()` 返回 false 并缓冲后续数据。
  // 单条 `tools/call` 的响应可能很大（岗位池 / 简历文本 / 代答全文），客户端读取慢时：
  //   · 忽略返回值继续 write → 数据在**进程内无限缓冲**，内存持续上涨；
  //   · 更关键的是 stdio 协议要求**逐行有序**，若在背压期间插入别的写操作，客户端可能按
  //     「已 flush 的顺序」解析出错乱的 JSON-RPC 帧。
  // 处置：维护一条**写队列** —— 一旦 `write()` 返回 false，后续写全部排队，直到 `drain` 再放行，
  // 保证：① 内存有界（最多积压一份未 drain 的队列，且队列本身受协议调用节奏约束）；
  // ② 帧顺序严格与调用顺序一致。日志仍直写 stderr（stderr 不参与协议，且本就用于诊断）。
  let outQueue = [];
  let draining = false;
  const flushQueue = () => {
    while (outQueue.length) {
      const line = outQueue.shift();
      // 仍在背压中：把该行放回队首，等下一次 drain
      if (process.stdout.write(line) === false) {
        outQueue.unshift(line);
        return;
      }
    }
  };
  process.stdout.on('drain', () => {
    draining = false;
    flushQueue();
  });
  const send = (msg) => {
    const line = `${JSON.stringify(msg)}\n`;
    if (draining) { outQueue.push(line); return; }
    if (process.stdout.write(line) === false) {
      // write 返回 false 表示「本行已接受、但需等待 drain」→ 后续行必须排队
      draining = true;
    }
  };
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const replyError = (id, code, message, data) =>
    send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });

  async function handleToolsCall(id, params) {
    const name = params?.name;
    if (!name || typeof name !== 'string') return replyError(id, ERR.INVALID_PARAMS, 'tools/call 需要 name');
    const tool = byName.get(name);
    if (!tool) return replyError(id, ERR.INVALID_PARAMS, `未知工具：${name}`);
    const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    const started = Date.now();
    try {
      const out = await tool.handler(args);
      const result = normalizeToolResult(out);
      log(`tools/call ${name} ok=${!result.isError} ${Date.now() - started}ms`);
      reply(id, result);
    } catch (e) {
      const msg = String(e?.stack || e?.message || e);
      log(`tools/call ${name} 抛异常：${msg}`);
      reply(id, {
        content: [{ type: 'text', text: `工具 ${name} 执行异常：${e?.message || e}` }],
        isError: true,
      });
    }
  }

  function normalizeToolResult(out) {
    if (out == null) return { content: [{ type: 'text', text: '(无输出)' }] };
    if (typeof out === 'string') return { content: [{ type: 'text', text: out }] };
    const text = typeof out.text === 'string' ? out.text : safeStringify(out.data ?? out);
    const content = [{ type: 'text', text }];
    // 可选图片内容块（如应用截图）：让 agent 能「看见」界面
    if (Array.isArray(out.images)) {
      for (const img of out.images) {
        if (img?.base64 && img?.mimeType) content.push({ type: 'image', data: img.base64, mimeType: img.mimeType });
      }
    }
    const result = { content };
    if (out.data !== undefined && out.data !== null) result.structuredContent = out.data;
    if (out.isError) result.isError = true;
    return result;
  }

  async function dispatch(msg) {
    const { id, method, params } = msg || {};
    const isNotification = id === undefined || id === null;

    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL;
        reply(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions,
        });
        return;
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/roots/list_changed':
        return; // 通知无响应
      case 'ping':
        reply(id, {});
        return;
      case 'logging/setLevel':
        reply(id, {});
        return;
      case 'tools/list':
        reply(id, {
          tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({
            name,
            ...(title ? { title } : {}),
            description,
            inputSchema: inputSchema || { type: 'object', properties: {} },
            ...(annotations ? { annotations } : {}),
          })),
        });
        return;
      case 'tools/call':
        await handleToolsCall(id, params);
        return;
      case 'resources/list':
        reply(id, { resources: [] });
        return;
      case 'prompts/list':
        reply(id, { prompts: [] });
        return;
      default:
        if (isNotification) return;
        replyError(id, ERR.METHOD_NOT_FOUND, `不支持的方法：${method}`);
    }
  }

  function start() {
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    // 在途请求计数：stdin 关闭时不立刻退出，先让已受理的请求跑完（避免长任务——例如
    // tsc/vite/打包——在客户端提前关闭 stdin 时被半路杀掉并丢失结果）。
    let inFlight = 0;
    let stdinClosed = false;
    let forceExitTimer = null;
    const maybeExit = () => {
      if (stdinClosed && inFlight === 0) {
        if (forceExitTimer) clearTimeout(forceExitTimer);
        // 不直接 process.exit：管道写是异步的，强制退出可能丢掉刚写入的响应；
        // 置 exitCode 后让事件循环自然结束，Node 会在 stdout 刷完后退出。
        process.exitCode = 0;
      }
    };
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch (e) {
        replyError(null, ERR.PARSE, `JSON 解析失败：${e?.message || e}`);
        return;
      }
      if (Array.isArray(msg)) {
        replyError(null, ERR.INVALID_REQUEST, '不支持批量请求');
        return;
      }
      inFlight += 1;
      // 审查 #13：`dispatch` 内 `reply()` → `process.stdout.write` 在客户端断开（EPIPE）时会抛错，
      // 使这个 Promise 进入 rejected 状态；原实现只有 `.finally`、没有 `.catch` → 产生
      // **unhandledRejection**（Node 15+ 默认直接终止进程，MCP 服务被一个断开的客户端打崩）。
      // 这里显式吞掉并记一行 stderr 日志，保证「单个请求失败」不会升级为「服务退出」。
      void dispatch(msg)
        .catch((e) => {
          log(`请求处理异常（已捕获，不影响服务）：${e?.stack || e?.message || e}`);
        })
        .finally(() => {
          inFlight -= 1;
          maybeExit();
        });
    });
    rl.on('close', () => {
      stdinClosed = true;
      if (inFlight === 0) {
        process.exitCode = 0;
        return;
      }
      log(`stdin 已关闭，等待 ${inFlight} 个在途请求完成（上限 120s）`);
      forceExitTimer = setTimeout(() => {
        log(`在途请求超时未完成（${inFlight} 个），强制退出`);
        process.exit(1);
      }, 120_000);
      forceExitTimer.unref?.();
    });
    log(`已启动（pid ${process.pid}，node ${process.version}），工具 ${tools.length} 个`);
  }

  return { start, tools: byName };
}

function safeStringify(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
