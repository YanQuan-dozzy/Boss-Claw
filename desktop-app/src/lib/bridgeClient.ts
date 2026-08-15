// 与 OpenClaw 本地桥接（Node）通信的渲染端客户端。
// 桥接为可选模块：PDF 在渲染进程内用纯 JS 解析；DOCX 走桥接（mammoth 在 Node 侧）。
const BRIDGE_PORT = 18765;
const BRIDGE_TOKEN = 'bossclaw-desktop-bridge';
const BASE = `http://127.0.0.1:${BRIDGE_PORT}`;

export interface BridgeResumeResult {
  ok: boolean;
  text?: string;
  method?: string;
  error?: string;
}

export async function bridgeParseResume(dataUrl: string, name: string): Promise<BridgeResumeResult> {
  const res = await fetch(`${BASE}/resume-text?token=${BRIDGE_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl, name }),
  });
  return res.json();
}

export async function bridgeStatus(): Promise<{ ok: boolean; [k: string]: unknown }> {
  try {
    const res = await fetch(`${BASE}/status?token=${BRIDGE_TOKEN}`);
    return res.json();
  } catch {
    return { ok: false };
  }
}
