// 超出上下文窗口预算的长文本 → **分片提炼后续调**（不截断丢弃）。
//
// 为什么需要这个模块：
//   `contextBudget.ts` 只负责「算预算」与「按预算裁剪 / 分片」的**纯函数**；当一段上下文
//   （长简历、长 JD、长补充材料）超出窗口预算时，纯裁剪只能把后半段砍掉。而被砍掉的恰恰常是
//   「最近的实习 / 最相关的项目」——评分与打招呼语最需要的事实。窗口再大也可能被一次超长输入顶满，
//   于是这里补上需要 AI 的那一步：
//       超窗长文本 → 切片 → 逐片提炼要点 → 合并成可投喂的文本 → 交主调用做一次整体裁决
//
// 关键口径（不可自行放宽）：
//   · **主裁决仍是一次调用**。分片只用于「把事实读进来」，不产生多个分数——否则会破坏
//     「AI 分 = 最终分」「同岗位重复分析落同一档」的既定评分口径。
//   · **成本护栏：最多 3 片**（即一次任务最多额外 3 次提炼调用）。超出片数的尾部内容不再提炼，
//     记 WARN 日志提示用户改用模型实际窗口或切换「全满」档。
//   · **任一环节失败即整体回落**为「按预算截断」（与接入本模块之前的行为完全一致），
//     绝不出现「部分分片成功、部分静默丢失」的中间态。
//   · 提炼出的要点**只能来自原文事实**，禁止推断/美化/编造；具体名称与数字原样保留
//     （与项目「只引用真实简历事实」的安全不变量一致）。
//
// 缓存：复用调用方已有的 `AICacheScope`（**不新增 scope**——`skills.ts` 的 SkillScope 直接复用
// 该类型，新增会让技能作用域枚举里冒出一个无意义的选项）。同一次分析的多次调用（如岗位评分与
// 打招呼语重写）会命中同一份提炼缓存，不重复计费。

import type { AppConfig } from './types';
import { cachedCallModel, type AICacheScope, type ChatMessage } from './llm';
import { estimateTokens, fitContextToTokens, resolveContextBudget, splitContext } from './contextBudget';
import { useRuntimeLogsStore } from '@/store/useRuntimeLogsStore';

/** 分片提炼的成本护栏：单次任务最多额外 3 次调用（用户确认的既定口径）。 */
export const MAX_CONDENSE_CHUNKS = 3;

/** 单片提炼的输出上限区间（合并后还要受主预算二次裁剪）。 */
const CHUNK_OUTPUT_TOKENS_MIN = 400;
const CHUNK_OUTPUT_TOKENS_MAX = 1500;

/** 单片输入占「本模型可用输入预算」的比例（留出提炼指令与协议开销）。 */
const CHUNK_INPUT_SHARE = 0.9;

const EXTRACT_SYSTEM =
  '你是求职简历信息提炼助手。只允许使用用户给出的原文中**真实存在**的事实，' +
  '严禁推断、补充、美化或编造任何经历、技能、成果、数字；不要输出原文中没有的公司/项目/技术名词。';

/**
 * 分片提炼提示词。
 * 刻意要求「保留具体名称与数字、单条短句、不要抽象成能力词」——因为下游要用它做岗位评分与
 * 打招呼语，抽象能力词（如「沟通能力强」）在评分口径里属于禁止项。
 */
function buildExtractPrompt(chunk: string, index: number, total: number, focus: string): string {
  return `下面是同一份简历原文的第 ${index + 1}/${total} 片（按顺序切分，可能从句子中间开始或结束）。

【提炼焦点】${focus}

请只抽取本片原文中**与提炼焦点相关的真实事实**，输出要点清单：
- 每行一条，以「- 」开头，单条 ≤ 36 字；
- 保留原文中的具体名称（公司 / 学校 / 专业 / 岗位 / 项目名 / 技术栈 / 证书）与数字（时间、规模、成绩）；
- 不要写「本片」「第 N 片」等元信息，不要解释，不要把事实抽象成「沟通能力强」这类无证据的能力词；
- 本片没有的事实一律不要出现。

原文：
${chunk}`;
}

export interface PrepareContextOptions {
  /** 该段上下文可用的 token 预算（由 allocateContextBudget / resolveContextBudget 算出） */
  tokenBudget: number;
  /** 提炼焦点：告诉模型「哪些信息值得保留」（如「与目标岗位匹配的简历事实」） */
  focus: string;
  /** 缓存作用域（复用调用方既有 scope，不新增） */
  cacheScope: AICacheScope;
  /** 用途标签（日志 / 缓存展示） */
  purpose?: string;
  /**
   * 'extract'（默认）：逐片提炼要点后合并；
   * 'transform'：逐片执行 `instruction` 变换（如「整理成工整简历正文」）后按序拼接——
   *   适用于**要求保真、不能压缩成要点**的任务（简历整理），此时分片等价于「分段处理再拼接」。
   */
  mode?: 'extract' | 'transform';
  /** transform 模式的逐片指令（system 用） */
  instruction?: string;
  /** 单片提炼的输出上限（默认按预算均分，夹在 400~1500 token） */
  perChunkOutputTokens?: number;
}

export interface PreparedContext {
  /** 可直接投喂的文本（已保证不超过 tokenBudget） */
  text: string;
  /** 是否发生了「分片提炼」 */
  condensed: boolean;
  /** 实际参与提炼的片数 */
  chunks: number;
  /** 因片数上限（3 片）未参与提炼的片数；>0 表示尾部内容未进入模型 */
  droppedChunks: number;
  /** 回落原因（发生失败回落时非空，供日志/调用方提示） */
  fallbackReason?: string;
}

/** 日志去重：批量分析时同一份超窗简历会被反复处理，提示只报一次（与 llm.ts 的缺 Key 提醒同思路）。 */
const notifiedKeys = new Set<string>();

function notifyOnce(key: string, level: 'info' | 'warn', message: string): void {
  if (notifiedKeys.has(key)) return;
  notifiedKeys.add(key);
  try {
    useRuntimeLogsStore.getState().addLog(level, message);
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/**
 * 准备一段上下文文本供投喂：
 *   ① 在预算内 → 原样返回（**零额外调用**，这是绝大多数情况）；
 *   ② 超出预算 → 分片提炼（≤3 片）后合并返回；
 *   ③ 提炼失败 → 回落为「按预算截断」，行为与本模块接入前一致。
 *
 * 返回值保证：`estimateTokens(text) <= tokenBudget` 或 `text` 为空。
 */
export async function prepareContextText(
  text: string,
  model: AppConfig['model'],
  opts: PrepareContextOptions,
): Promise<PreparedContext> {
  const source = String(text || '');
  const budget = Math.max(0, Math.floor(Number(opts.tokenBudget) || 0));
  if (!source) return { text: '', condensed: false, chunks: 0, droppedChunks: 0 };
  if (budget <= 0) return { text: '', condensed: false, chunks: 0, droppedChunks: 0 };

  // ① 预算内：零成本直通
  if (estimateTokens(source) <= budget) {
    return { text: source, condensed: false, chunks: 1, droppedChunks: 0 };
  }

  const noticeKey = `${opts.purpose || 'context'}:${opts.cacheScope}`;
  const mode = opts.mode === 'transform' ? 'transform' : 'extract';

  // ② 分片：片内大小按**本模型可用输入预算**计算（保证单片提炼调用自身不超窗），与主预算解耦
  const perChunkInputBudget = Math.max(
    800,
    Math.floor(
      resolveContextBudget(model, { outputTokens: opts.perChunkOutputTokens ?? CHUNK_OUTPUT_TOKENS_MAX })
        .inputBudgetTokens * CHUNK_INPUT_SHARE,
    ),
  );
  const allChunks = splitContext(source, perChunkInputBudget);
  const picked = allChunks.slice(0, MAX_CONDENSE_CHUNKS);
  const droppedChunks = Math.max(0, allChunks.length - picked.length);

  // 单片输出上限：按主预算均分（合并后总量才不会反过来超预算），并夹在合理区间
  const perChunkOutput = Math.max(
    CHUNK_OUTPUT_TOKENS_MIN,
    Math.min(
      CHUNK_OUTPUT_TOKENS_MAX,
      Math.floor(budget / Math.max(1, picked.length)),
    ),
  );

  const fallback = (reason: string): PreparedContext => ({
    text: fitContextToTokens(source, budget),
    condensed: false,
    chunks: 0,
    droppedChunks,
    fallbackReason: reason,
  });

  try {
    // 并行提炼：片数有上限（≤3），并发可控；同一片重复出现时由 AI 缓存与 in-flight 去重兜住
    const parts = await Promise.all(
      picked.map(async (chunk, index) => {
        const messages: ChatMessage[] =
          mode === 'transform'
            ? [
                { role: 'system', content: String(opts.instruction || '').trim() || EXTRACT_SYSTEM },
                {
                  role: 'user',
                  content:
                    `这是同一份材料的第 ${index + 1}/${picked.length} 片（按顺序切分）。` +
                    `请只处理这一片，输出本片对应的内容，不要添加前言、后语、片号说明。\n\n${chunk}`,
                },
              ]
            : [
                { role: 'system', content: EXTRACT_SYSTEM },
                { role: 'user', content: buildExtractPrompt(chunk, index, picked.length, opts.focus) },
              ];
        const raw = await cachedCallModel(
          messages,
          model,
          { jsonMode: false, temperature: 0.1, maxTokens: perChunkOutput, timeoutMs: 60000 },
          { scope: opts.cacheScope },
        );
        const out = String(raw || '').trim();
        // 单片为空视为该片提炼失败：整体回落，避免「静默少了一片」
        if (!out) throw new Error(`第 ${index + 1} 片提炼结果为空`);
        return out;
      }),
    );

    const merged =
      mode === 'transform'
        ? parts.join('\n\n')
        : `【简历原文超出上下文窗口预算，以下为分片提炼的事实要点（按原文顺序）】\n${parts.join('\n')}`;

    // 合并后仍超预算（提炼未压到预期）：按预算二次裁剪，保证「返回即可投喂」的契约
    const finalText = estimateTokens(merged) <= budget ? merged : fitContextToTokens(merged, budget);

    if (droppedChunks > 0) {
      notifyOnce(
        `${noticeKey}:dropped`,
        'warn',
        `上下文超出窗口预算，已自动分片提炼（上限 ${MAX_CONDENSE_CHUNKS} 片），仍有 ${droppedChunks} 片内容未进入模型。` +
          '若希望完整覆盖，请在「设置 → AI / LLM 配置」把「上下文长度」改为所用模型的**实际**窗口大小，或把「上下文用量」切到「全满」。',
      );
    } else {
      notifyOnce(
        noticeKey,
        'info',
        `上下文超出窗口预算，已自动分片提炼为事实要点后继续处理（${picked.length} 片，内容未丢弃）。`,
      );
    }

    return { text: finalText, condensed: true, chunks: picked.length, droppedChunks };
  } catch (error: any) {
    // ③ 任一环节失败 → 整体回落截断（不做「部分成功」的中间态）
    const reason = String(error?.message || '分片提炼失败');
    notifyOnce(
      `${noticeKey}:fallback`,
      'warn',
      `上下文超出窗口预算且分片提炼未成功（${reason}），本次已改为按窗口预算截断内容。` +
        '可在「设置 → AI / LLM 配置」把「上下文长度」改为模型实际窗口，或切换「上下文用量」为「全满」。',
    );
    return fallback(reason);
  }
}
