// 打招呼语（求职信）提示词来源优先级：① skill（greetings 技能，含用户自定义技能）→ ② 简历中心输入框内容 → ③ 本地规则。
// 统一用于工作台岗位分析 / 简历中心 JD 预览 / 定制简历求职信（见 prompts.ts 的 DEFAULT_ANALYZE_GREETING_INSTRUCTIONS 注释）。
// 安全不变量（对齐 AGENTS.md 2.1）：所有提示词与招呼语必须使用求职者第一人称口吻，
// 仅引用真实简历事实；禁止承诺薪资、到岗时间、面试时间或不存在的能力/经历。
import type { AppConfig, Profile } from './types';
import { callModel } from './llm';

/** 打招呼语目标字数（字符数，含标点）：生成目标约 150 字。 */
export const GREETING_TARGET_CHARS = 150;
/** 打招呼语硬上限（字符数，含标点）：不得超过 200 字。 */
export const GREETING_MAX_CHARS = 200;
/** 打招呼语合格下限（字符数）：低于此值信息量不足，触发再生成。 */
export const GREETING_MIN_CHARS = 120;
/** 打招呼语「长度不符合 → 再生成」的最大重试次数（到达后仅做最终安全兜底）。 */
export const GREETING_MAX_RETRY = 3;
/** 归一化截断上限（比常规硬上限更紧）：用于多来源文本合并等需要更保守的场景（normalizeGreetingText）。 */
export const GREETING_NORMALIZE_MAX_CHARS = 160;
/**
 * 提示词统一引用口径（P6-06）：供各提示词插值，避免「提示词手写 250 与校验 200 互相拆台」——
 * AI 按提示词写 210~250 字是合规的，但 isGreetingLengthOk 判不合规 → 触发再生成 → 截断。
 * 需要同步的位置：prompts.ts / skills.ts / jobAssistant.ts / 5 个 SKILL.md。
 */
export const GREETING_LENGTH_RULE = `全文 ${GREETING_MIN_CHARS}-${GREETING_MAX_CHARS} 字（含标点，建议约 ${GREETING_TARGET_CHARS} 字），单行不换行`;

/** 长度判定：打招呼语是否落在合格区间（≥下限 且 ≤上限，含目标 150 字）。不在这里硬截断。 */
export function isGreetingLengthOk(len: number): boolean {
  return len >= GREETING_MIN_CHARS && len <= GREETING_MAX_CHARS;
}

/**
 * 单行化 + 智能截断（打招呼语 / 求职信 / AI 跟聊回复共用）。
 * 先压成单行（BOSS 聊天框按 Enter 发送，多行会导致只发前半句）；
 * 超长时按「句末标点 → 逗号/顿号 → 硬切」三级回退截断，
 * 避免出现「我对贵公司 A」这类截在半个词 / 半句话中间的残句
 * （此前是裸 slice(0,220)，用户实测即被切在句子中间）。
 */
export function clampGreetingText(text: string, maxChars: number = GREETING_MAX_CHARS): string {
  const oneLine = String(text || '').trim().replace(/\s+/g, ' ');
  if (oneLine.length <= maxChars) return oneLine;
  const head = oneLine.slice(0, maxChars);
  const brk = (chars: string[]) => Math.max(...chars.map((c) => head.lastIndexOf(c)));
  // 句末标点（。！？；）与句内分隔（，）
  const sentenceIdx = brk(['。', '！', '？', '；', '!', '?', ';']);
  const clauseIdx = brk(['，', ',']);
  const cutAt = (idx: number) => `${head.slice(0, idx).trimEnd()}。`;
  // ① 句末标点落在预算后段（≥60%）：直接保留到该句末尾，信息量足够
  if (sentenceIdx >= 8 && sentenceIdx >= maxChars * 0.6) return head.slice(0, sentenceIdx + 1);
  // ② 句末标点太靠前（如「开头锚点句。」+ 一个超长第二句会把其余内容全丢掉）：
  //    退到最后一个逗号处补齐句号，尽量保住「身份 + 最相关亮点」这两个必要元素
  if (clauseIdx >= 8 && clauseIdx > sentenceIdx) return cutAt(clauseIdx);
  // ③ 只剩句末标点可用
  if (sentenceIdx >= 8) return head.slice(0, sentenceIdx + 1);
  // ④ 一个标点都没有（极端情况）：只能硬切
  return head;
}

export function normalizeGreetingText(text: string): string {
  // P6-06：具名归一化上限（比常规截断更紧，语义见 GREETING_NORMALIZE_MAX_CHARS）
  return clampGreetingText(text, GREETING_NORMALIZE_MAX_CHARS);
}

// =====「AI 跟聊」回复 =====
// 对齐 AI-BossJob Core.aiReply / generatePersonalizedReply：读取 HR 最新消息并在聊天页 AI 回复。
// 安全不变量（AGENTS.md 2.1）：求职者口吻；只引用简历真实事实；不得承诺薪资/到岗时间/面试时间/不存在的能力。
const REPLY_MIN_LEN = 8;

// 基础指令（不主动承诺薪资/面试/到岗时间等；有沟通信息时由下方分支放开）
const REPLY_SYSTEM_PROMPT_BASE = `你是求职者本人（第一人称），正在与招聘方 HR 线上沟通，回复 HR 发来的最新消息。
安全规则：只能引用简历中的真实事实；不得编造简历中不存在的经历与能力；不得暴露自己是 AI。语气自然口语化、真诚，像真人聊天。
直接给出要发送的回复内容，不要任何前缀、引号或解释。`;
// 无「沟通信息」时：不主动承诺薪资、面试/到岗时间或任何未填写的安排（原行为，稳健）
const REPLY_SYSTEM_PROMPT = `${REPLY_SYSTEM_PROMPT_BASE}\n不主动承诺薪资、面试/到岗时间或任何未填写的安排。`;
// 用户提供「沟通信息」时：可引用其中填写的内容（薪资期望、面试/到岗时间等，仅限明确提到的），不编造不在其中的内容
const REPLY_SYSTEM_PROMPT_WITH_TIME = `${REPLY_SYSTEM_PROMPT_BASE}\n可引用用户在「沟通信息」中填写的具体内容（如薪资期望、面试/到岗时间等），仅限该信息中明确提到的内容，不得编造不在其中的内容。`;

// 未提供「沟通信息」时拒绝的「承诺/安排」类表述（薪资、面试/到岗时间等）
const FABRICATED_COMMIT = /薪资.{0,8}(要求|期望|多少|是|给)|期望薪资|实习工资|可到岗|现在(就)?入职|到岗时间|随时到岗|面试时间|可以面试|安排面试/;

function isAcceptableReply(text: string, allowInfo = false): boolean {
  const raw = String(text || '').trim();
  if (raw.length < REPLY_MIN_LEN) return false;
  // 招聘方口吻 / 承诺性表述一律拒绝（对齐 AGENTS.md 2.1 口吻与承诺红线）
  if (/看到你的简历|你的简历|很匹配我们|匹配我们|欢迎.*沟通|期待你|候选人|我们团队|我们公司|团队主要涉及|你很匹配/.test(raw)) return false;
  // 只有用户填写了「沟通信息」时，才允许回复引用薪资/面试/到岗等安排（否则视为 AI 自行承诺）
  if (!allowInfo && FABRICATED_COMMIT.test(raw)) return false;
  return true;
}

function buildLocalReply(jobTitle: string): string {
  const t = String(jobTitle || '').trim();
  return t
    ? `您好，谢谢您联系我。我想了解更多关于「${t}」岗位的具体工作内容，希望能多沟通，谢谢。`
    : '您好，谢谢您联系我。我想进一步了解岗位的具体工作内容，希望能多沟通，谢谢。';
}

export interface ReplyResult {
  text: string;
  method: 'ai' | 'local' | 'none';
  warning?: string;
}

/**
 * 生成对 HR 最新消息的 AI 回复（跟聊）。
 * 用 callModel 直连（不缓存：回复与被回复消息强相关、随时间变化）。
 * AI 未配置 / 生成失败 / 未通过口吻校验时回退到安全的通用回复。
 */
export async function generateReply(opts: {
  hrMessage: string;
  jobTitle?: string;
  resumeText?: string;
  profile?: Profile | null;
  /** 用户填写的沟通信息（薪资期望/面试时间/到岗时间等，自行填写）：有则 AI 回复时引用；无则维持原回复行为 */
  communicationInfo?: string;
  model: AppConfig['model'];
}): Promise<ReplyResult> {
  const hr = String(opts.hrMessage || '').trim();
  if (!hr) return { text: '', method: 'none' };
  const localFallback = buildLocalReply(opts.jobTitle || '');
  if (!opts.model?.apiKey) {
    return { text: localFallback, method: 'local', warning: 'AI 尚未配置，本次使用通用回复。' };
  }
  const comm = String(opts.communicationInfo || '').trim();
  try {
    const profileBrief = opts.profile
      ? {
          summary: opts.profile.summary,
          skills: opts.profile.facts?.skills,
          experiences: opts.profile.facts?.experiences,
        }
      : null;
    const commBlock = comm ? `\n\n我的沟通信息（可在回复中引用其中的真实内容，如薪资期望、面试/到岗时间等，仅限填写的内容）：\n${comm}` : '';
    const sysPrompt = comm ? REPLY_SYSTEM_PROMPT_WITH_TIME : REPLY_SYSTEM_PROMPT;
    const user = `HR 的最新消息："${hr}"\n\n应聘岗位：${String(opts.jobTitle || '未知岗位')}\n\n简历信息：\n${String(
      opts.resumeText || ''
    ).slice(0, 3000)}\n\n职业画像：\n${JSON.stringify(profileBrief || {})}${commBlock}\n\n请直接给出你作为求职者的回复内容：`;
    const content = await callModel(
      [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: user },
      ],
      opts.model,
      { temperature: 0.6, maxTokens: 400, jsonMode: false, timeoutMs: 45000 }
    );
    const text = normalizeGreetingText(String(content || ''));
    // 提供了「沟通信息」时才允许回复引用其中的薪资/面试/到岗等安排（否则仅用简历事实）
    if (isAcceptableReply(text, Boolean(comm))) return { text, method: 'ai' };
    return {
      text: localFallback,
      method: 'local',
      warning: 'AI 回复未通过求职者口吻/承诺校验，已回退为通用回复。',
    };
  } catch (error: any) {
    return {
      text: localFallback,
      method: 'local',
      warning: `AI 回复生成失败（${error?.message || '未知原因'}），已回退为通用回复。`,
    };
  }
}
