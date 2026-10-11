// 与 OpenClaw 本地桥接（Node）通信的渲染端客户端。
// 桥接为可选模块：PDF 在渲染进程内用纯 JS 解析；DOCX 走桥接（mammoth 在 Node 侧）。
//
// C-2：令牌不再硬编码（原 `bossclaw-desktop-bridge` 随 bundle 分发），改为经主进程 IPC 读取
// 运行时生成的随机令牌（~/.bossclaw/bridge-token），并以请求头 X-Bossclaw-Token 传递。
import { electronApi } from '@/lib/electronApi';

const BRIDGE_PORT = 18765;
const BASE = `http://127.0.0.1:${BRIDGE_PORT}`;

export interface BridgeResumeResult {
  ok: boolean;
  text?: string;
  method?: string;
  error?: string;
}

let cachedToken: string | null = null;

/** 取本地桥令牌（IPC → ~/.bossclaw/bridge-token）；不可得时返回空串（请求将被桥以 403 拒绝）。 */
async function bridgeToken(): Promise<string> {
  if (cachedToken !== null) return cachedToken;
  const t = await electronApi.bridge.token();
  cachedToken = t || '';
  return cachedToken;
}

async function bridgeHeaders(): Promise<Record<string, string>> {
  return { 'Content-Type': 'application/json', 'X-Bossclaw-Token': await bridgeToken() };
}

export async function bridgeParseResume(dataUrl: string, name: string): Promise<BridgeResumeResult> {
  // P21：超时 + 失败兜底，与 bridgeStatus 保持一致，桥未启动时返回 {ok:false} 而非抛未处理异常
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(`${BASE}/resume-text`, {
        method: 'POST',
        headers: await bridgeHeaders(),
        body: JSON.stringify({ dataUrl, name }),
        signal: ctrl.signal,
      });
      const data = await res.json();
      return data as BridgeResumeResult;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false, method: 'bridge', error: '本地桥接不可用或超时，请启动 OpenClaw 桥接服务' };
  }
}

export async function bridgeStatus(): Promise<{ ok: boolean; [k: string]: unknown }> {
  try {
    // P30：超时兜底——桥端口若被占用但进程不响应（半开连接），无超时的 fetch 会永久 pending，
    // App 15s 心跳会逐次堆积挂起请求（内存/句柄泄漏、后台卡死）。3s 超时后按「未连接」处理。
    const res = await fetch(`${BASE}/status`, { headers: await bridgeHeaders(), signal: AbortSignal.timeout(3000) });
    return res.json();
  } catch {
    return { ok: false };
  }
}
