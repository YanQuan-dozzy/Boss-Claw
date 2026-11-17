/**
 * 网关能力探测的模块级缓存（单权威读点）。
 *
 * 探测结果按 `baseUrl|modelName` 键缓存：一次成功的 /v1/models 拉取即可让
 * Settings 页（思考开关、上下文档位、能力徽标）与 llm.ts 请求侧共享同一份判定，
 * 且同一会话内重复触发不会重复发请求。
 *
 * 探测本身在 main.cjs（`jc:models-probe`，主进程 fetch、回环放行、公网强制 https）。
 * 本模块只负责把「探测原始文本」解析成能力索引并缓存 —— 不发起网络请求。
 *
 * 缓存策略：
 * - **失败不缓存**（网络不通 / 网关返回非 200 / 解析失败）：下次触发会重新探测，
 *   设置页因此可反复「重试」，不会被一次失败永久锁死。
 * - **成功结果持久化到 localStorage**（key `bossclaw-model-capabilities`）：应用重启后
 *   不必等设置页重新探测，llm.ts 也能直接用上次的判定 —— 否则用户开着思考的应用
 *   重启后会发现思考参数悄悄不发了（UI 与请求侧判定都读这份持久化）。
 * - 同一键并发探测去重（in-flight Map）：连点「测试连接」不会打两次 /v1/models。
 */
import { electronApi } from '@/lib/electronApi';
import {
  parseModelCapabilitiesResponse,
  findModelCapability,
  type ModelCapability,
} from './modelCapabilities';

export interface CapabilityProbeResult {
  ok: boolean;
  capability: ModelCapability | null;
  count: number;
  status: number;
  error: string;
  notes: string[];
}

interface CapCacheEntry {
  baseUrl: string;
  modelName: string;
  /** 探测时刻（epoch ms） */
  ts: number;
  ok: boolean;
  capability: ModelCapability | null;
  count: number;
  status: number;
  error: string;
  notes: string[];
}

const cache = new Map<string, CapCacheEntry>();
const inFlight = new Map<string, Promise<CapCacheEntry>>();

const STORAGE_KEY = 'bossclaw-model-capabilities';
const STORAGE_VERSION = 1;
const MAX_PERSIST_ENTRIES = 40; // 换过很多模型时只留最近的，避免 localStorage 膨胀

const cacheKey = (baseUrl: string, modelName: string) =>
  `${String(baseUrl || '').trim().toLowerCase()}|${String(modelName || '').trim().toLowerCase()}`;

/** 探测超时：/v1/models 是小响应，10s 足够（llm-proxy 默认 90s 太长，设置页要等得起） */
export const MODELS_PROBE_TIMEOUT_MS = 10_000;

/** 从 localStorage 恢复上次成功探测（无副作用，调用任意多次都行）。 */
function hydrate(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.entries)) return;
    for (const e of parsed.entries) {
      if (!e || typeof e.baseUrl !== 'string' || typeof e.modelName !== 'string') continue;
      const key = cacheKey(e.baseUrl, e.modelName);
      if (cache.has(key)) continue;
      cache.set(key, {
        baseUrl: e.baseUrl,
        modelName: e.modelName,
        ts: Number(e.ts) || 0,
        ok: e.ok === true,
        capability: e.capability || null,
        count: Number(e.count) || 0,
        status: Number(e.status) || 0,
        error: String(e.error || ''),
        notes: Array.isArray(e.notes) ? (e.notes as unknown[]).map((x) => String(x)) : [],
      });
    }
  } catch {
    /* 解析失败（损坏）就当作没有缓存，下次探测覆盖 */
  }
}

/** 持久化当前成功缓存（截断到最近 MAX_PERSIST_ENTRIES 条）。 */
function persist(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const entries = [...cache.values()]
      .filter((e) => e.ok && e.capability)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, MAX_PERSIST_ENTRIES)
      .map((e) => ({
        baseUrl: e.baseUrl,
        modelName: e.modelName,
        ts: e.ts,
        ok: true,
        capability: e.capability,
        count: e.count,
        status: e.status,
        error: e.error,
        notes: e.notes,
      }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, entries }));
  } catch {
    /* 配额满等场景忽略，不阻塞业务 */
  }
}

hydrate();

/** 清除指定 baseUrl+model 的缓存与持久化（模型/端点变更后旧结果作废）。 */
export function invalidateCapabilitiesCache(baseUrl: string, modelName: string): void {
  const key = cacheKey(baseUrl, modelName);
  cache.delete(key);
  inFlight.delete(key);
  persist();
}

/** 取缓存能力（不触发探测）。探测失败/未缓存 → null。 */
export function getCachedCapability(baseUrl: string, modelName: string): ModelCapability | null {
  const hit = cache.get(cacheKey(baseUrl, modelName));
  return hit && hit.ok ? hit.capability : null;
}

/** 探测指定 baseUrl+model 的能力。成功结果写入缓存与持久化；失败可随时重试。 */
export async function probeModelCapabilities(
  baseUrl: string,
  modelName: string,
  apiKey: string,
): Promise<CapabilityProbeResult> {
  const key = cacheKey(baseUrl, modelName);
  const hit = cache.get(key);
  if (hit && hit.ok) {
    return {
      ok: true,
      capability: hit.capability,
      count: hit.count,
      status: hit.status,
      error: hit.error,
      notes: hit.notes,
    };
  }

  // 去重：同一键已有在途探测就复用它
  const pending = inFlight.get(key);
  if (pending) return toProbeResult(await pending);

  const task = (async (): Promise<CapCacheEntry> => {
    const url = `${String(baseUrl || '').trim().replace(/\/+$/, '')}/models`;
    const r = await electronApi.modelsProbe(url, apiKey, MODELS_PROBE_TIMEOUT_MS);

    let capability: ModelCapability | null = null;
    let count = 0;
    let notes: string[] = [];
    const parsed = r.ok && r.status === 200 ? parseModelCapabilitiesResponse(r.text) : null;
    if (parsed) {
      count = parsed.count;
      notes = parsed.notes;
      capability = findModelCapability(parsed.byId, modelName);
      if (!capability && parsed.count > 0) {
        notes = [...notes, `在网关返回的 ${parsed.count} 个模型中未找到「${modelName}」`];
      }
    }

    const entry: CapCacheEntry = {
      baseUrl,
      modelName,
      ts: Date.now(),
      ok: Boolean(parsed?.ok) && capability !== null,
      capability,
      count,
      status: Number(r.status || 0),
      error: r.error || '',
      notes,
    };
    if (entry.ok) {
      cache.set(key, entry);
      persist();
    }
    return entry;
  })();

  inFlight.set(key, task);
  try {
    const entry = await task;
    if (!entry.ok) {
      // 失败不缓存（可重试）；同时在途 Map 里也删掉，方便下次重新探测
      inFlight.delete(key);
    }
    return toProbeResult(entry);
  } catch (e) {
    inFlight.delete(key);
    return {
      ok: false,
      capability: null,
      count: 0,
      status: 0,
      error: String((e as Error)?.message || e),
      notes: ['探测过程异常，请重试'],
    };
  }
}

function toProbeResult(entry: CapCacheEntry): CapabilityProbeResult {
  return {
    ok: entry.ok,
    capability: entry.capability,
    count: entry.count,
    status: entry.status,
    error: entry.error,
    notes: entry.notes,
  };
}
