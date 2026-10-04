// 全局「自动沟通」后台引擎（跨页面持久运行）
// ---------------------------------------------------------
// 原 useAutoChatEngine 是组件钩子：切页后组件卸载，批量任务随之丢失。
// 这里把运行器提升为模块级单例（Zustand store），使「开始批量沟通」后即使切到工作台，
// 任务仍在后台继续运行；同时运行器每个周期重新读取 pending，
// 工作台新批准的岗位会自动进入当前批次的自动沟通队列（无需重新点「开始」）。
//
// 安全不变量与旧实现一致：冷却/每日上限/限速/首条验收/风控交人工均保留；
// 「分批」改由定时任务显式表达（每次触发可带 scope：目标平台 + 单轮上限）。
import { create } from 'zustand';
import { useDataStore } from '@/store/useDataStore';
import { useRuntimeLogsStore } from '@/store/useRuntimeLogsStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import {
  camoufoxChat, camoufoxChatWatch, camoufoxRestart, isCamoufoxStopCode, isCamoufoxEnvCode,
  type CamoufoxChatResult, type ChatHistoryEntry, type ChatWatchConversation,
} from '@/lib/bossclaw/camoufox';
import {
  effectiveDailyCap, effectiveDailyCapFor, dailySentCount, dailySentCountFor,
  isLockedOut, cooldownRemaining, SAFETY_LIMITS, classifyRiskCode, nextCooldownUntil,
} from '@/lib/bossclaw/safety';
import { sharedPacer, markDelivered, resetDeliveredSinceRest } from '@/lib/bossclaw/deliveryThrottle';
import { checkDeliveryGate, batchRestDelayMs } from '@/lib/bossclaw/activityWindow';
import { cleanTitle } from '@/lib/bossclaw/jobDisplay';
import { getErrorMessage } from '@/lib/bossclaw/helpers';
import { generateReply } from '@/lib/bossclaw/greetings';
import { rerankPending } from '@/lib/bossclaw/priority';
import { platformEnabled, platformLabel, platformPriority, platformSupports } from '@/lib/bossclaw/platforms';
import { claimDelivery, isDeliveryClaimed, releaseDelivery } from '@/lib/bossclaw/deliveryLock';
import type { PendingItem, ImageResume, JobPlatform } from '@/lib/bossclaw/types';

type ChatJobOutcome = 'success' | 'failed' | 'stop' | 'continue';

/** 从岗位元信息中提取纯 encryptJobId */
function extractJobId(job: PendingItem['job']): string {
  const j = job || {};
  let jid = String(j.jobId || '').trim();
  const kv = jid.match(/(?:encryptJobId|jobId|securityId|lid)=([^&?#]+)/i);
  if (kv) jid = kv[1];
  jid = jid.replace(/\.html$/i, '').trim();
  if (jid && !/^https?:/i.test(jid)) return jid;
  const m = String(j.url || '').match(/job_detail\/([^/?#.]+)/i);
  return m ? m[1].replace(/\.html$/i, '') : '';
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 后台自动沟通负责的岗位状态（与工作台「一键投递」分工，避免争抢）：
 *  - approved（已批准待投递）：本后台负责发打招呼语；
 *  - opened（工作台「点击立即沟通」仅打开聊天窗、未发打招呼语）：本后台完成打招呼语的发送；
 *  - approved_queue（投递中）归工作台「一键投递」引擎所有，本后台不处理；
 *  - pending（待确认）未批准，本后台不自动投递。
 */
const BATCH_ELIGIBLE = ['approved', 'opened'];
/** 队列空闲时轮询工作台新批准岗位的间隔 */
const IDLE_POLL_MS = 6000;

// ---- 模块级运行态（不受组件卸载影响）----
// P2-04：原 5 个独立 let（runToken / busy / ownerRun / processedIds / cancelRequested）承载运行态，
// 其中「busy 互斥」与「ownerRun 归属」是同一件事的两个表达，曾有两处手写复位需人工保证一致。
// 现收敛为单一对象 currentRun：null = 空闲，busy↔owner 的配对由「对象是否仍是 currentRun」唯一表达；
// 运行 token 单调递增，stop()/自然结束时 currentRun 置空即作废旧 run（并发/串台由引用比较保证）。
interface EngineRun {
  token: number;             // 本 run 的唯一标识（nextRunToken 单调递增生成）
  processedIds: Set<string>; // 本次运行已处理/已取走的岗位 id
  cancelRequested: boolean;  // stop() 置位的发送取消信号：chatJob 在真正网络发送前检查，已置位则不发送、不计成功
}
let nextRunToken = 0;                    // 单调递增：每次 start()/chatOne() 取新 token
let currentRun: EngineRun | null = null; // 单一真值：null = 空闲（替代原 busy 互斥量 + ownerRun 归属）
// pacer 与「连续投递计数」都**不在本模块持有**：二者是账号级保护，必须与「工作台一键投递」
// 共享同一实例（见 deliveryThrottle.ts / 审查 #73）。本模块只经 pacerNow() 取共享 pacer。
const pacerNow = () => sharedPacer(useSettingsStore.getState().config.maxActionsPerMinute);

// =====「AI 跟聊监听」常驻循环（对齐觅星小臣的单一串行 worker）=====
// 持续巡检「已投递（sent）」的 BOSS 会话，发现 HR 发了新消息就带多轮上下文生成回复并发送。
// 与「批量投递」共用同一 pacer/冷却/风控不变量；批量投递运行时本轮监听让路（避免两个隐身窗口争抢）。
/** 每轮巡检间隔（毫秒）：轮询所有在跟会话，兜底频率 */
const WATCH_CYCLE_MS = 120_000;
/** 每轮最多巡检的会话数（防止回复风暴；按最近互动时间优先） */
const WATCH_MAX_PER_CYCLE = 6;
/** 同一轮内两次巡检之间的最小间隔（毫秒，叠加随机抖动） */
const WATCH_MIN_BETWEEN_MS = 20_000;
interface WatchRun {
  token: number;            // 本监听 run 的唯一标识（复用 nextRunToken 单调递增）
  seq: number;              // 监听代际（每次 setWatch(true) 递增；旧 run 退出时若代际已变则不关闭常驻会话）
  cancelRequested: boolean; // setWatch(false)/stop() 置位：唤醒后立即退出
}
let currentWatch: WatchRun | null = null; // 单一真值：null = 监听未运行

// ===== Camoufox 引擎自愈重启（误触关闭后自动拉起；多次失败自动停止）=====
const MAX_ENGINE_RESTART = 3;
const ENGINE_RESTART_WAIT_MS = 8000;

/** 判定沟通结果是否因「Camoufox 引擎不可用 / 传输层故障」失败（无 BOSS 业务码失败）。 */
function looksEngineDown(r: CamoufoxChatResult): boolean {
  return !r.ok && r.code == null && Boolean(r.error || r.message);
}

/**
 * 带引擎自愈的沟通调用：因引擎不可用失败 → 自动重启 Camoufox 引擎并重试当前岗位；
 * 连续 MAX_ENGINE_RESTART 次重启仍失败 → 返回 {dead:true}，由调用方自动停止自动沟通。
 */
async function chatWithEngineRecovery(
  send: () => Promise<CamoufoxChatResult>,
  jobTitle: string,
  platform = 'boss'
): Promise<{ result: CamoufoxChatResult; dead: boolean }> {
  let result = await send();
  if (!looksEngineDown(result)) return { result, dead: false };
  for (let i = 1; i <= MAX_ENGINE_RESTART; i += 1) {
    useRuntimeLogsStore.getState().addChatLog({
      level: 'warn',
      stage: 'system',
      jobTitle,
      msg: `⚠️ 检测到 Camoufox 引擎异常，正在重启（第 ${i}/${MAX_ENGINE_RESTART} 次）...`,
      errorDetail: String(result?.error || result?.message || ''),
    });
    let ready = false;
    try {
      const st = await camoufoxRestart(platform);
      ready = Boolean(st?.ready);
    } catch {
      ready = false;
    }
    await sleep(ENGINE_RESTART_WAIT_MS);
    if (ready) {
      useRuntimeLogsStore.getState().addChatLog({
        level: 'info',
        stage: 'system',
        jobTitle,
        msg: '✅ Camoufox 引擎已恢复，正在重试当前岗位...',
      });
      result = await send();
      if (!looksEngineDown(result)) return { result, dead: false };
    }
  }
  return { result, dead: true };
}

/** camoufoxChat 的 opts 类型（复用其签名，避免另写一份参数定义）。 */
type ChatOpts = NonNullable<Parameters<typeof camoufoxChat>[2]>;

/**
 * 生成并发送一次「AI 跟聊」回复（首次投递命中 needsReply 与「AI 跟聊监听」共用）。
 * 对齐觅星小臣：带多轮聊天记录生成结构化决策；HR 明确拒绝即收口；无需回复时只记指纹不发送。
 * 返回：sent=已发送；rejected=HR 已拒绝（收口）；none=无需回复；stop=引擎不可用需停止监听。
 */
async function aiReplyAndSend(args: {
  item: PendingItem;
  jobId: string;
  title: string;
  company: string;
  hrMessage: string;
  hrHistory?: ChatHistoryEntry[];
  baseOpts: ChatOpts;
}): Promise<{ outcome: 'sent' | 'rejected' | 'none' | 'stop'; result?: CamoufoxChatResult }> {
  const { item, jobId, title, company, hrMessage, hrHistory, baseOpts } = args;
  const { updatePending } = useDataStore.getState();
  const { addChatLog, addLog } = useRuntimeLogsStore.getState();
  const platform = String(item.job?.platform || 'boss');
  const hrPreview = hrMessage.slice(0, 200);

  addChatLog({
    level: 'stage', stage: 'ai_reply', jobId, jobTitle: title, company,
    msg: '检测到 HR 已发来消息，正在生成 AI 回复...',
    errorDetail: hrMessage ? `HR 消息：${hrPreview}` : '',
  });

  const reply = await generateReply({
    hrMessage,
    chatHistory: hrHistory,
    jobTitle: item.job?.title || '',
    resumeText: useDataStore.getState().resumeText,
    profile: useDataStore.getState().profile,
    communicationInfo: useDataStore.getState().communicationInfo,
    model: useSettingsStore.getState().config.model,
  });

  // HR 明确拒绝：不再回复，收口该会话（记录指纹 + 拒绝时间，避免下一轮重复生成）
  if (reply.outcome === 'hr_rejected') {
    updatePending(item.id, { hrRejectedAt: Date.now(), hrRepliedFingerprint: hrMessage });
    addChatLog({
      level: 'warn', stage: 'ai_reply', jobId, jobTitle: title, company,
      msg: 'AI 判断 HR 已明确拒绝，结束该会话（不再回复）', errorDetail: hrPreview,
    });
    addLog('warn', `HR 已拒绝，已结束跟聊：${title}`);
    return { outcome: 'rejected' };
  }
  // 无需回复（系统提示 / 表情 / 无实质内容）：只记指纹，避免下一轮重复调用 AI
  if (!reply.text) {
    updatePending(item.id, { hrRepliedFingerprint: hrMessage });
    addChatLog({
      level: 'info', stage: 'ai_reply', jobId, jobTitle: title, company,
      msg: 'AI 判断本条无需回复（系统提示或无实质内容）', errorDetail: hrPreview,
    });
    return { outcome: 'none' };
  }

  addChatLog({
    level: reply.method === 'ai' ? 'info' : 'warn',
    stage: 'ai_reply', jobId, jobTitle: title, company,
    msg: reply.method === 'ai' ? `AI 回复已生成：${reply.text.slice(0, 60)}...` : (reply.warning || 'AI 回复已生成'),
    errorDetail: reply.text,
  });
  if (reply.interview) {
    addChatLog({
      level: 'info', stage: 'ai_reply', jobId, jobTitle: title, company,
      msg: '📅 AI 识别到 HR 面试邀约（请及时在 BOSS 内确认具体安排）',
    });
  }

  const canAttach = platformSupports(platform as JobPlatform, 'attach');
  const replySend = await chatWithEngineRecovery(
    () => camoufoxChat(jobId, reply.text, {
      ...baseOpts,
      mode: 'reply',
      replyText: reply.text,
      // HR 索要简历 → 回复后附带在线简历（图片简历仍按用户设置）
      sendOnlineResume: canAttach && (Boolean(baseOpts.sendOnlineResume) || reply.sendResume),
    }),
    title, platform
  );
  if (replySend.dead) {
    addChatLog({
      level: 'error', stage: 'system', jobId, jobTitle: title, company,
      msg: '❌ 发送 AI 回复时 Camoufox 引擎多次重启失败，自动沟通已自动停止',
      errorDetail: '请检查引擎/登录态后重试。',
    });
    addLog('error', `发送 AI 回复时引擎多次重启失败，自动沟通已停止：${title}`);
    return { outcome: 'stop', result: replySend.result };
  }
  // 成功：记录「已回复的 HR 消息指纹」，防止同一条消息被重复回复
  updatePending(item.id, { hrRepliedFingerprint: hrMessage });
  return { outcome: 'sent', result: replySend.result };
}

/** 单条岗位沟通（桥接 camoufox，逻辑与旧 useAutoChatEngine.chatJob 一致） */
async function chatJob(item: PendingItem): Promise<ChatJobOutcome> {
  const { updatePending } = useDataStore.getState();
  const { addLog, addChatLog } = useRuntimeLogsStore.getState();
  const cfg = useSettingsStore.getState().config;
  const title = cleanTitle(item.job?.title);
  const company = item.job?.company || '';
  const greeting = String(item.deliveryGreeting || item.analysis?.greeting || '').trim();

  if (!greeting) {
    updatePending(item.id, { status: 'failed', error: '招呼语为空，无法自动沟通，请补充后再试', retryable: true });
    addChatLog({ level: 'error', stage: 'greeting', jobTitle: title, company, msg: '沟通中断：岗位招呼语为空', errorDetail: '请编辑招呼语后重试' });
    return 'failed';
  }

  const jobId = extractJobId(item.job);
  if (!jobId) {
    updatePending(item.id, { status: 'failed', error: '岗位缺少 jobId，无法自动沟通', retryable: false });
    addChatLog({ level: 'error', stage: 'open_chat', jobTitle: title, company, msg: '沟通中断：岗位缺少 jobId 参数' });
    return 'failed';
  }

  addChatLog({
    level: 'stage',
    stage: 'open_chat',
    jobId,
    jobTitle: title,
    company,
    msg: `唤起隐身浏览器，正在打开「${title} @ ${company}」沟通窗口...`,
  });

  const greetingLen = greeting.length;
  addChatLog({
    level: 'info',
    stage: 'greeting',
    jobId,
    jobTitle: title,
    company,
    msg: `准备发送个性化招呼语 (${greetingLen}字)`,
    greetingPreview: greeting,
  });

  try {
    // 多平台适配：岗位平台（boss/liepin/zhaopin/job51），缺省 boss
    const platform = String(item.job?.platform || 'boss');
    // 能力矩阵判定（唯一入口，勿硬编码 platform === 'boss'）：
    // attach = 投递时补发简历附件 / 在线简历。当前仅 BOSS 聊天链路支持；
    // 其余平台 deliver() 会忽略这两个参数，故这里直接不下发，避免构造无用的 base64 负载。
    const canAttach = platformSupports(platform as JobPlatform, 'attach');
    // P04：真正发送前检查取消信号——已用户停止，则不发送、不计成功，保留岗位待下次恢复
    // （chatJob 仅由持有 currentRun 的 start()/chatOne() 调用，此处即本 run 的取消信号）
    if (currentRun?.cancelRequested) {
      addChatLog({ level: 'warn', stage: 'system', jobId, jobTitle: title, company, msg: '⏹ 已取消发送（用户已停止），岗位保留待下次恢复' });
      return 'stop';
    }
    const resumeImages: { name: string; data: string }[] = canAttach && cfg.sendResumeImage
      ? (useDataStore.getState().imageResumes as ImageResume[]).map((r) => ({ name: r.name, data: r.data }))
      : [];
    const baseOpts = {
      os: cfg.camoufox?.os,
      platform,
      url: item.job?.url || '',
      sendResumeImage: canAttach && Boolean(cfg.sendResumeImage),
      sendOnlineResume: canAttach && Boolean(cfg.sendOnlineResume),
      attachmentDelaySeconds: Math.max(0, Number(cfg.attachmentDelaySeconds) || 4),
      recruiterName: item.job?.recruiterName || '',
      company: item.job?.company || '',
      jobTitle: item.job?.title || '',
      resumeImages,
    };
    const initial = await chatWithEngineRecovery(() => camoufoxChat(jobId, greeting, baseOpts), title, platform);
      // Camoufox 引擎多次重启仍失败 → 自动停止自动沟通（不误触关闭即停，也不标记岗位为死失败）
      if (initial.dead) {
        updatePending(item.id, { status: 'failed', error: 'Camoufox 引擎多次重启失败，自动沟通已停止', retryable: true });
        addChatLog({
          level: 'error',
          stage: 'system',
          jobId,
          jobTitle: title,
          company,
          msg: '❌ Camoufox 引擎多次重启失败，自动沟通已自动停止',
          errorDetail: '请检查引擎/登录态后重试。',
        });
        addLog('error', `Camoufox 引擎多次重启失败，自动沟通已停止：${title}`);
        return 'stop';
      }
      let result = initial.result;
      // 本次成功是否属于「HR 来消息后的 AI 跟聊回复」（仅回复不计入单日投递上限，避免占用投递名额）
      let sentAsReply = false;

    // 外部网申岗位：不能自动投递/沟通，标记跳过（对齐 job-claw externalApplicationInfo / 优先级 -6000）
    if (result.external || result.code === 600) {
      updatePending(item.id, { status: 'skipped', error: '外部网申岗位，跳过', retryable: false });
      addChatLog({
        level: 'warn',
        stage: 'skip',
        jobId,
        jobTitle: title,
        company,
        msg: '外部网申岗位，无法自动投递，已跳过（不加成功计数）',
      });
      addLog('warn', `跳过外部网申岗位：${title}`);
      return 'continue';
    }

    // 目标 HR/会话疑似冲突：不发送、暂停批次（对齐 AGENTS.md 2.1「明确冲突不发送」）
    if (result.conflict || result.code === 602) {
      updatePending(item.id, { status: 'failed', error: result.message || '目标 HR/会话冲突', retryable: false, riskBlocked: true });
      addChatLog({
        level: 'error',
        stage: 'verify_chat_target',
        jobId,
        jobTitle: title,
        company,
        msg: `目标 HR/会话核验冲突：${result.message || '已暂停发送'}`,
        errorDetail: '安全规则：目标 HR 或会话明确冲突时不发送。已在浏览器停留，请人工核对后处理。',
      });
      addLog('error', `目标 HR 冲突：${title}`);
      return 'stop';
    }

    // 已与 HR 建立会话且无需回复（code 701）→ 不重复发打招呼语，标记跳过并收口
    if (result.alreadyChatted || result.code === 701) {
      updatePending(item.id, { status: 'skipped', error: '已建立会话，跳过重复打招呼', retryable: false });
      addChatLog({
        level: 'warn', stage: 'skip', jobId, jobTitle: title, company,
        msg: '已与该 HR 建立会话且最后一条是我方消息，跳过重复打招呼（避免打扰）',
      });
      addLog('warn', `跳过重复打招呼：${title}`);
      return 'continue';
    }

    // HR 已发来消息 →「AI 跟聊」（对齐 AI-BossJob aiReply + 觅星小臣多轮决策）：
    // 带完整聊天记录生成结构化回复并以回复文本发送。仅 BOSS 聊天链路支持。
    if (platform === 'boss' && result.needsReply) {
      const hrMessage = String(result.hrLastMessage || '').trim();
      // 已收口（HR 曾明确拒绝）或已回复过这条消息 → 不再重复生成/发送
      const curNow = useDataStore.getState().pending.find((x) => x.id === item.id);
      if (curNow?.hrRejectedAt || (hrMessage && curNow?.hrRepliedFingerprint === hrMessage)) {
        return 'continue';
      }
      const replyOut = await aiReplyAndSend({
        item: curNow || item,
        jobId,
        title,
        company,
        hrMessage,
        hrHistory: Array.isArray(result.hrHistory) ? result.hrHistory : undefined,
        baseOpts,
      });
      if (replyOut.outcome === 'stop') {
        updatePending(item.id, { status: 'failed', error: 'Camoufox 引擎多次重启失败，自动沟通已停止', retryable: true });
        return 'stop';
      }
      if (replyOut.outcome !== 'sent') return 'continue'; // 已拒绝 / 无需回复：不改岗位状态
      result = replyOut.result!;
      sentAsReply = true;
    }

    if (result.ok && result.sent) {
      // 用户已在沟通过程中手动「跳过」该岗位 → 尊重跳过，不再覆写为已沟通
      const curNow = useDataStore.getState().pending.find((x) => x.id === item.id);
      if (curNow?.status === 'skipped') {
        addChatLog({
          level: 'warn',
          stage: 'skip',
          jobId,
          jobTitle: title,
          company,
          msg: '⏭ 用户已手动跳过该岗位，本次沟通结果不再计入（浏览器中的发送结果以实际气泡为准）',
        });
        return 'continue';
      }
      // 回复类发送不计入「今日投递」上限：仅置 status=sent 并记录 replySentAt，不改写投递用的 sentAt，
      // 从而不占用 dailySentCount（sentAt 为今天）统计出的投递岗位数；若此前已投递过（sentAt 已在），仍只算 1 条投递。
      updatePending(item.id, sentAsReply
        ? { status: 'sent', error: '', replySentAt: Date.now() }
        : { status: 'sent', error: '', sentAt: Date.now() });

      addChatLog({
        level: 'success',
        stage: 'confirm',
        jobId,
        jobTitle: title,
        company,
        msg: sentAsReply
          ? `AI 跟聊回复发送成功！已回复 HR 消息（不计入今日投递数）`
          : `沟通成功！文字气泡已确认发送（模式：${result.method === 'browser-chat' ? '浏览器真实交互' : result.method || 'ok'}）`,
        method: result.method,
      });

      if (cfg.sendOnlineResume || cfg.sendResumeImage) {
        addChatLog({
          level: 'info',
          stage: 'resume',
          jobId,
          jobTitle: title,
          company,
          msg: '附件状态：已触发在线简历/图片简历打包同步',
        });
      }
      addLog('success', `自动沟通成功：${title}`);
      return 'success';
    }

    const code = result.code ?? null;
    const msg = String(result.message || result.error || '自动沟通失败');
    const isRiskStop = isCamoufoxStopCode(code) || code === 35;
    if (isRiskStop) {
      updatePending(item.id, { status: 'failed', error: msg, retryable: false, riskBlocked: true });
      useSettingsStore.getState().setConfig({ pausedUntil: nextCooldownUntil(useSettingsStore.getState().config, classifyRiskCode(code)) });
      addChatLog({
        level: 'error',
        stage: 'risk',
        jobId,
        jobTitle: title,
        company,
        msg: `命中安全风控警示码 [Code ${code}]：${msg}。引擎已进入保护性冷却！`,
        errorDetail: '安全规则红线：遇到风控或人机验证必须停止，请在浏览器中人工核验后再重试。',
      });
      addLog('error', `自动沟通命中风控码 ${code}：${msg}`);
      return 'stop';
    }
    if (isCamoufoxEnvCode(code)) {
      addChatLog({
        level: 'error',
        stage: 'risk',
        jobId,
        jobTitle: title,
        company,
        msg: `环境异常 [Code ${code}]：${msg}。请先完成扫码登录。`,
        errorDetail: msg,
      });
      return 'stop';
    }
    updatePending(item.id, { status: 'failed', error: msg, retryable: true });
    addChatLog({
      level: 'error',
      stage: 'confirm',
      jobId,
      jobTitle: title,
      company,
      msg: `沟通未完成：${msg}`,
      errorDetail: msg,
    });
    return 'failed';
  } catch (e: unknown) {
    const msg = getErrorMessage(e);
    useDataStore.getState().updatePending(item.id, { status: 'failed', error: msg, retryable: true });
    useRuntimeLogsStore.getState().addChatLog({
      level: 'error',
      stage: 'system',
      jobId,
      jobTitle: title,
      company,
      msg: `沟通过程抛出异常：${msg}`,
      errorDetail: msg,
    });
    return 'failed';
  }
}

export interface AutoChatProgress {
  index: number;
  total: number;
}

/** 会话级去重：会话名 → 已处理过的「HR 最后一条消息」指纹（常驻会话页内实时去重，防重复回复） */
const watchHandled = new Map<string, string>();
/** 监听代际：每次 setWatch(true) 递增；旧循环退出时若代际已变则不再关闭常驻会话（归新循环管） */
let watchSeq = 0;
/** 会话身份归一（匹配工作台岗位用：去空白/括号/连字符，转小写） */
function normConvText(v: unknown): string {
  return String(v || '').replace(/[\s（）()·\-—_/\\|]/g, '').toLowerCase();
}

/** 该会话是否「在等我回复」：接口有 fromId 信息时按「最后一条来自 HR / 未读」，否则只要有预览就交给 open 判定 */
function isWaitingConversation(c: ChatWatchConversation, apiHasFromInfo: boolean): boolean {
  if (apiHasFromInfo && !c.dom) {
    const hrLast = Boolean(c.uid) && Boolean(c.lastFromId) && c.lastFromId === c.uid;
    return Boolean(c.unread) || hrLast;
  }
  return Boolean(c.unread) || Boolean(String(c.preview || '').trim());
}

/** 把会话匹配到工作台已投递岗位（用于记录 replySentAt / 指纹）：仅按 HR 姓名或公司做保守精确匹配 */
function matchPendingForConversation(conv: ChatWatchConversation, pending: PendingItem[]): PendingItem | null {
  const name = normConvText(conv.name);
  const company = normConvText(conv.company);
  if (!name && !company) return null;
  for (const p of pending) {
    if (p.status !== 'sent') continue;
    const recruiter = normConvText(p.job?.recruiterName);
    const pCompany = normConvText(p.job?.company);
    if (name && recruiter && name === recruiter) return p;
    if (company && pCompany && (company === pCompany || company.includes(pCompany) || pCompany.includes(company))) return p;
  }
  return null;
}

/** 风控/环境码统一处置：命中即停止监听（冷却 / 交人工），绝不重试（AGENTS.md 红线） */
function handleWatchStopCode(
  run: WatchRun,
  code: number | null | undefined,
  message: string,
  conv?: ChatWatchConversation
): boolean {
  if (code == null) return false;
  const { addChatLog, addLog } = useRuntimeLogsStore.getState();
  const jobTitle = conv?.name || '';
  const company = conv?.company || '';
  if (isCamoufoxStopCode(code) || code === 35) {
    useSettingsStore.getState().setConfig({ pausedUntil: nextCooldownUntil(useSettingsStore.getState().config, classifyRiskCode(code)) });
    addChatLog({
      level: 'error', stage: 'risk', jobTitle, company,
      msg: `命中安全风控警示码 [Code ${code}]：${message}。跟聊监听已停止并进入保护性冷却！`,
      errorDetail: '安全规则红线：遇到风控或人机验证必须停止，请在浏览器中人工核验后再重试。',
    });
    addLog('error', `跟聊监听命中风控码 ${code}，已停止`);
    run.cancelRequested = true;
    return true;
  }
  if (isCamoufoxEnvCode(code)) {
    addChatLog({
      level: 'error', stage: 'risk', jobTitle, company,
      msg: `环境异常 [Code ${code}]：${message}。请先完成扫码登录。`,
    });
    run.cancelRequested = true;
    return true;
  }
  return false;
}

/**
 * 「AI 跟聊监听」一轮：常驻会话页上 scan 会话列表 → 对「HR 发了最后一条」的会话 open 读记录
 * → 生成多轮结构化回复 → send 回复。全程串行，复用同一 pacer / 冷却 / 风控不变量；
 * 批量投递运行时本轮让路（避免两个隐身窗口争抢）。
 */
async function watchCycle(run: WatchRun): Promise<void> {
  // 批量投递运行时让路：避免两个隐身浏览器窗口争抢与重复动作
  if (useAutoChatStore.getState().chatRunning) return;
  const cfg = useSettingsStore.getState().config;
  if (isLockedOut(cfg)) return;                 // 冷却期：本轮不巡检
  if (!platformEnabled(cfg, 'boss')) return;

  const { addChatLog, addLog } = useRuntimeLogsStore.getState();
  const scan = await camoufoxChatWatch('scan', { os: cfg.camoufox?.os });
  if (handleWatchStopCode(run, scan.code, scan.message || '')) return;
  if (!scan.ok) {
    addChatLog({ level: 'warn', stage: 'system', msg: `跟聊监听：读取会话列表失败（${scan.message || scan.error || '未知原因'}）` });
    return;
  }
  const conversations = scan.conversations || [];
  if (!conversations.length) return;
  const apiHasFromInfo = conversations.some((c) => Boolean(c.uid) && Boolean(c.lastFromId));
  const waiting = conversations.filter((c) => isWaitingConversation(c, apiHasFromInfo));
  if (!waiting.length) return;
  addChatLog({ level: 'info', stage: 'ai_reply', msg: `跟聊监听：发现 ${waiting.length} 个会话可能有新消息，逐个核对…` });

  for (const conv of waiting.slice(0, WATCH_MAX_PER_CYCLE)) {
    if (currentWatch !== run || run.cancelRequested) return;
    if (useAutoChatStore.getState().chatRunning) return; // 批量投递插入 → 本轮让路

    const c0 = useSettingsStore.getState().config;
    if (isLockedOut(c0)) return;
    const convName = String(conv.name || '');
    const convCompany = String(conv.company || '');
    if (!convName) continue;
    useAutoChatStore.setState({ watchActiveId: convName });
    // ⚠️ 本循环（跟聊监听巡检）**不做批次休息**，原因有二（2026-10-03 纠正）：
    //   1) 语义不符：`batchRest` 的口径是「每 N 个**岗位**休息」，而这里处理的是**会话巡检**，
    //      计数口径不同，混用会让「连续投递数」虚高；
    //   2) 会双重计数：同一账号级计数已被批量投递循环使用，
    //      两个循环各自 +1 → 批次边界提前命中，休息次数与设置值不符。
    // 批次休息的唯一落点是批量投递循环（见下方 `markDelivered()`）。
    try {
      await pacerNow().waitForSlot();
      const open = await camoufoxChatWatch('open', { os: c0.camoufox?.os, name: convName, company: convCompany });
      if (handleWatchStopCode(run, open.code, open.message || '', conv)) return;
      if (!open.ok) {
        // 打开失败（会话已折叠/页面结构变化等）：不阻断整轮，下一轮再试
        continue;
      }
      if (!open.needsReply || !open.hrLastMessage) continue;

      const fp = String(open.hrLastMessage);
      const matched = matchPendingForConversation(conv, useDataStore.getState().pending);
      // 已收口 / 已回复过这条 HR 消息 → 跳过（防重复回复）
      if (matched?.hrRejectedAt) continue;
      if (watchHandled.get(convName) === fp) continue;
      if (matched?.hrRepliedFingerprint === fp) continue;

      const reply = await generateReply({
        hrMessage: fp,
        chatHistory: Array.isArray(open.history) ? open.history : undefined,
        jobTitle: matched?.job?.title || open.jobName || '',
        resumeText: useDataStore.getState().resumeText,
        profile: useDataStore.getState().profile,
        communicationInfo: useDataStore.getState().communicationInfo,
        model: useSettingsStore.getState().config.model,
      });

      // HR 明确拒绝：收口该会话，不再回复
      if (reply.outcome === 'hr_rejected') {
        watchHandled.set(convName, fp);
        if (matched) useDataStore.getState().updatePending(matched.id, { hrRejectedAt: Date.now(), hrRepliedFingerprint: fp });
        addChatLog({
          level: 'warn', stage: 'ai_reply', jobTitle: matched?.job?.title || convName, company: convCompany,
          msg: `AI 判断「${convName}」已明确拒绝，结束该会话（不再回复）`,
        });
        addLog('warn', `HR 已拒绝，已结束跟聊：${convName}`);
        continue;
      }
      // 无需回复（系统提示 / 表情 / 无实质内容）：只记指纹，避免下一轮重复调用 AI
      if (!reply.text) {
        watchHandled.set(convName, fp);
        if (matched) useDataStore.getState().updatePending(matched.id, { hrRepliedFingerprint: fp });
        addChatLog({
          level: 'info', stage: 'ai_reply', jobTitle: matched?.job?.title || convName, company: convCompany,
          msg: `AI 判断「${convName}」本条无需回复（系统提示或无实质内容）`,
        });
        continue;
      }

      addChatLog({
        level: reply.method === 'ai' ? 'info' : 'warn',
        stage: 'ai_reply', jobTitle: matched?.job?.title || convName, company: convCompany,
        msg: reportReplyText(open.hrLastMessage, reply.text, reply.method, reply.warning),
        errorDetail: reply.text,
      });
      if (reply.interview) {
        addChatLog({
          level: 'info', stage: 'ai_reply', jobTitle: matched?.job?.title || convName, company: convCompany,
          msg: '📅 AI 识别到 HR 面试邀约（请及时在 BOSS 内确认具体安排）',
        });
      }

      const send = await camoufoxChatWatch('send', {
        name: open.name || convName,
        company: open.company || convCompany,
        text: reply.text,
      });
      if (handleWatchStopCode(run, send.code, send.message || '', conv)) return;
      if (send.ok && send.sent) {
        watchHandled.set(convName, fp);
        addChatLog({
          level: 'success', stage: 'confirm', jobTitle: matched?.job?.title || convName, company: convCompany,
          msg: `AI 跟聊回复发送成功！已回复「${convName}」（不计入今日投递数，依据：${open.matchedBy || 'content'} 身份校验）`,
        });
        addLog('success', `AI 跟聊回复成功：${convName}`);
        // 回复类发送不计入单日投递上限：仅记录 replySentAt（不改 sentAt）
        if (matched) {
          useDataStore.getState().updatePending(matched.id, { status: 'sent', error: '', replySentAt: Date.now(), hrRepliedFingerprint: fp });
        }
      } else {
        addChatLog({
          level: 'error', stage: 'ai_reply', jobTitle: matched?.job?.title || convName, company: convCompany,
          msg: `AI 回复发送失败：${send.message || send.error || '未知原因'}（下一轮会重试）`,
        });
      }
    } catch (e: unknown) {
      addChatLog({ level: 'error', stage: 'system', jobTitle: convName, company: convCompany, msg: `跟聊处理异常：${getErrorMessage(e)}` });
    } finally {
      useAutoChatStore.setState({ watchActiveId: null });
    }
    await sleep(WATCH_MIN_BETWEEN_MS + Math.random() * 8_000);
  }
}

/** 回复生成结果的可读日志（AI 与本地兜底分开措辞） */
function reportReplyText(hrMessage: string, replyText: string, method: string, warning?: string): string {
  const head = `检测到「${String(hrMessage).slice(0, 30)}」→ `;
  return method === 'ai'
    ? `${head}AI 回复已生成：${replyText.slice(0, 60)}...`
    : `${head}${warning || '已生成兜底回复'}：${replyText.slice(0, 60)}...`;
}

/**
 * 启动「AI 跟聊监听」常驻循环：先拉起常驻会话页（start），再按轮 scan→open→send；
 * 单一串行执行（currentWatch 引用比较保证不串台）。退出时关闭常驻浏览器（仅当代际未变，避免关掉新会话）。
 */
function watchLoop(run: WatchRun): void {
  void (async () => {
    const { addChatLog } = useRuntimeLogsStore.getState();
    const cfg = useSettingsStore.getState().config;
    let started = false;
    try {
      const st = await camoufoxChatWatch('start', { os: cfg.camoufox?.os });
      if (currentWatch !== run || run.cancelRequested) return;
      if (!st.ok) {
        addChatLog({
          level: 'error', stage: 'system',
          msg: `AI 跟聊监听启动失败：${st.message || st.error || '未知原因'}`,
        });
        return;
      }
      started = true;
      addChatLog({
        level: 'info', stage: 'system',
        msg: `👂 AI 跟聊监听已启动：常驻 BOSS 会话页，持续扫描所有 HR 会话并自动带上下文回复（每 ${Math.round(WATCH_CYCLE_MS / 60000)} 分钟一轮，批量投递运行时会自动让路）。`,
      });
      while (currentWatch === run && !run.cancelRequested) {
        try {
          await watchCycle(run);
        } catch {
          /* 单轮异常不影响下一轮 */
        }
        // 分片休眠：停止信号可提前唤醒
        const steps = Math.ceil(WATCH_CYCLE_MS / 1000);
        for (let i = 0; i < steps; i += 1) {
          if (currentWatch !== run || run.cancelRequested) break;
          await sleep(1000);
        }
      }
    } finally {
      if (currentWatch === run) currentWatch = null;
      // 仅当代际未变（没有新的 setWatch(true) 接手）时才关闭常驻会话
      if (started && watchSeq === run.seq) {
        try {
          await camoufoxChatWatch('stop');
        } catch {
          /* 忽略关闭异常 */
        }
      }
      watchHandled.clear();
      useAutoChatStore.setState({ watchRunning: false, watchActiveId: null });
    }
  })();
}

/**
 * 批量沟通的可选限定范围（由「定时投递」任务等入口传入；手动启动不传 = 全部已启用平台、不限额）：
 *  - platforms：仅处理这些平台的任务（需同时满足「平台已启用」）；空/缺省 = 全部已启用平台。
 *  - maxCount：本次运行成功沟通达到该条数即结束；0/缺省 = 不限。
 * 冷却/每日上限/首条验收/风控等安全守卫在任何 scope 下都优先于本范围生效。
 */
export interface AutoChatScope {
  platforms?: JobPlatform[];
  maxCount?: number;
}

interface AutoChatState {
  chatRunning: boolean;
  /** 「AI 跟聊监听」是否运行中（常驻后台，持续跟进 HR 回复） */
  watchRunning: boolean;
  activeChatId: string | null;
  /** 跟聊监听当前正在巡检的岗位 id（UI 高亮用） */
  watchActiveId: string | null;
  progress: AutoChatProgress;
  /** 启动后台批量沟通：持续处理当前队列，并自动接收工作台新批准岗位 */
  start: (scope?: AutoChatScope) => void;
  /** 仅处理单个岗位（不与批量并发） */
  chatOne: (item: PendingItem) => void;
  /** 开启/关闭「AI 跟聊监听」（对齐觅星小臣的常驻 AI 回复 worker） */
  setWatch: (on: boolean) => void;
  /** 停止后台任务（批量沟通 + 跟聊监听） */
  stop: () => void;
}

export const useAutoChatStore = create<AutoChatState>((set) => ({
  chatRunning: false,
  watchRunning: false,
  activeChatId: null,
  watchActiveId: null,
  progress: { index: 0, total: 0 },

  start: (scope?: AutoChatScope) => {
    if (currentRun || useAutoChatStore.getState().chatRunning) return;
    const run: EngineRun = { token: ++nextRunToken, processedIds: new Set<string>(), cancelRequested: false };
    currentRun = run; // 建立互斥（busy）：单一真值，null = 空闲
    const cfg = useSettingsStore.getState().config;
    // 预算同步到共享 pacer（内部夹到 SAFETY_LIMITS.MAX_ACTIONS_PER_MINUTE 硬上限；见审查 #22/#73）。
    // 注意：批次休息计数**不再随本轮重置** —— 它是跨引擎的账号级累计，只在真正休息完成后归零，
    // 否则任一引擎起跑都会把另一引擎的累计清零（原「每轮重置」在双引擎并行下必然互相踩）。
    sharedPacer(cfg.maxActionsPerMinute);
    set({ chatRunning: true, activeChatId: null, progress: { index: 0, total: 0 } });
    // 范围描述（定时任务触发时为任务 scope；手动启动无 scope → 全平台不限量）
    const scopeText = (() => {
      const parts: string[] = [];
      if (scope?.platforms?.length) parts.push(`平台：${scope.platforms.map((p) => platformLabel(p)).join('/')}`);
      if (scope?.maxCount && scope.maxCount > 0) parts.push(`本次上限 ${scope.maxCount} 条`);
      return parts.length ? `（${parts.join('；')}）` : '';
    })();
    useRuntimeLogsStore.getState().addChatLog({
      level: 'info',
      stage: 'system',
      msg: `🚀 批量自动沟通已在后台启动${scopeText}：持续处理当前队列，并会在工作台新批准岗位时自动加入继续沟通（切到工作台仍会继续运行）。`,
    });

    void (async () => {
      let sentCount = 0;
      let stopAll = false;
      let greeted = false;
      try {
        while (currentRun === run) {
          const data = useDataStore.getState();
          const loopCfg = useSettingsStore.getState().config;
          // 多平台串行消费：
          //   1) 候选 = 待沟通(approved/opened) 且未被取走/占锁 且「平台仍启用」的岗位；
          //   2) 从候选中选出「设置优先级最高（数字最小）」的平台组——先跑完该平台全部任务
          //      （含已打开沟通窗待补发 opened），该平台无剩余可沟通岗位后才切换到下一优先级平台。
          // 已停用平台（platforms[p].enabled=false）的岗位不进入自动沟通，等待用户重新启用。
          const pfKey = (p: PendingItem) =>
            platformPriority(loopCfg, String(p.job?.platform || 'boss') as 'boss' | 'liepin' | 'zhaopin' | 'job51');
          const allEligible = rerankPending(data.pending, loopCfg).filter(
            (p: PendingItem) =>
              BATCH_ELIGIBLE.includes(p.status) &&
              // HR 已明确拒绝（AI 跟聊判定）的会话不再投递
              !p.hrRejectedAt &&
              !run.processedIds.has(p.id) &&
              !isDeliveryClaimed(p.id, String(p.job?.platform || 'boss')) &&
              platformEnabled(loopCfg, String(p.job?.platform || 'boss') as 'boss' | 'liepin' | 'zhaopin' | 'job51') &&
              // 定时投递 scope：仅处理本次任务圈定的平台（空/缺省 = 全部已启用平台）
              (!scope?.platforms?.length ||
                scope.platforms.includes((p.job?.platform || 'boss') as JobPlatform))
          );

          // 队列暂空 → 后台轮询，等待工作台新批准岗位
          if (allEligible.length === 0) {
            if (!greeted) {
              greeted = true;
              useRuntimeLogsStore.getState().addChatLog({
                level: 'info',
                stage: 'system',
                msg: '👀 当前后台队列已处理完。任务保持运行，工作台新批准的岗位会自动进入沟通队列。',
              });
            }
            set({ progress: { index: run.processedIds.size, total: run.processedIds.size } });
            await sleep(IDLE_POLL_MS);
            continue;
          }
          // 平台硬串行：仅取最优先平台组；该组清空后（switch）下一轮自然轮到次优平台。
          const topPfKey = Math.min(...allEligible.map(pfKey));
          const eligible = allEligible.filter((p) => pfKey(p) === topPfKey);
          const item = eligible[0];

          // —— 消费前守卫（P03：冷却/每日上限/单轮上限这些非「实际发送」的判定，
          //    必须在 claimDelivery + run.processedIds.add 之前执行，否则会把整队列预占却一条不发，
          //    守卫放行后这些岗位才会被 processedIds 排除 → 不会永久空轮询）——
          const nowCfg = useSettingsStore.getState().config;
          // B1：冷却/每日上限/首条验收/风控这些内部退出路径不置空 currentRun，
          //    直接 break 由 finally 正常复位 chatRunning（否则 chatRunning 卡死、start() 被拦死）。
          if (isLockedOut(nowCfg)) {
            useRuntimeLogsStore.getState().addChatLog({
              level: 'warn',
              stage: 'risk',
              msg: `账号处于安全冷却期，后台沟通已暂停（剩余约 ${Math.ceil(cooldownRemaining(nowCfg) / 60000)} 分钟）。点击「停止」后可稍后重试。`,
            });
            break;
          }
          // 活跃时段（与 Workbench.precheckDelivery 同一权威，见 activityWindow.ts）：
          // 卡片虽挂在「自动沟通」页，但保护对象是**账号** —— 两个引擎必须同口径，
          // 否则「关掉工作台、只跑自动沟通」就能在凌晨 3 点持续作业。
          // 与工作台同样采取「中止本轮 + 告知恢复时刻」而非等待（最长要等十几小时，不能阻塞界面）。
          {
            const gate = checkDeliveryGate(nowCfg.activeHours, nowCfg.pausedUntil);
            if (!gate.ok) {
              const resumeAt = gate.nextAllowedAt ? new Date(gate.nextAllowedAt).toLocaleString('zh-CN') : '活跃时段开始后';
              useRuntimeLogsStore.getState().addChatLog({
                level: 'warn',
                stage: 'risk',
                msg: `${gate.reason}。预计 ${resumeAt} 自动恢复（可在「设置 → 自动沟通 → 防封号节奏限制」中调整或关闭）。`,
              });
              break;
            }
          }
          if (dailySentCount(useDataStore.getState().pending) >= effectiveDailyCap(nowCfg)) {
            useRuntimeLogsStore.getState().addChatLog({
              level: 'warn',
              stage: 'risk',
              msg: `今日沟通数已触及安全上限 ${effectiveDailyCap(nowCfg)} 条，后台沟通已暂停。`,
            });
            break;
          }
          // 多平台适配：平台每日投递上限（min(该平台每日目标, 平台侧上限如智联 100/日, 150)）
          // 命中后整组跳过该平台岗位（不再逐条告警/预占），转交下一优先级平台，不中断整批
          {
            const itemPlatform = (item.job?.platform || 'boss') as 'boss' | 'liepin' | 'zhaopin' | 'job51';
            if (dailySentCountFor(useDataStore.getState().pending, itemPlatform) >= effectiveDailyCapFor(nowCfg, itemPlatform)) {
              useRuntimeLogsStore.getState().addChatLog({
                level: 'warn',
                stage: 'risk',
                msg: `平台 ${itemPlatform} 今日投递已达上限 ${effectiveDailyCapFor(nowCfg, itemPlatform)} 条，该平台剩余岗位本轮跳过（可在「设置 → 招聘平台」调整每日目标）。`,
              });
              for (const e of eligible) run.processedIds.add(e.id);
              continue;
            }
          }
          // 单轮上限（定时投递任务限定）：成功沟通达到 scope.maxCount 即结束本次运行
          if (scope?.maxCount && scope.maxCount > 0 && sentCount >= scope.maxCount) {
            useRuntimeLogsStore.getState().addChatLog({
              level: 'warn',
              stage: 'system',
              msg: `⏱ 本次投递已达设定上限（${scope.maxCount} 条），本次任务结束（下个触发时刻会再次启动）。`,
            });
            break;
          }


          // 走到这里才真正要发送 → 才认领占位锁并记入 processedIds（B1/P03；多平台：锁带平台前缀）
          const itemPlatformKey = String(item.job?.platform || 'boss');
          if (!claimDelivery(item.id, itemPlatformKey)) {
            // 已被其他引擎认领投递，本轮跳过（交给认领方），下周期若被释放则重新纳入
            continue;
          }
          run.processedIds.add(item.id);
          set({ activeChatId: item.id, progress: { index: run.processedIds.size, total: run.processedIds.size + eligible.length } });
          try {
            // 批次休息（分钟级中断）——与 Workbench.awaitDeliveryGap 同口径：
            // 秒级岗位间隔打断不了 24h 活动曲线的直线性，只有分钟级中断才行。
            const sinceRest = markDelivered();
            const restMs = batchRestDelayMs(nowCfg.batchRest, sinceRest);
            if (restMs > 0) {
              useRuntimeLogsStore.getState().addChatLog({
                level: 'info',
                stage: 'system',
                msg: `已连续沟通 ${sinceRest} 个岗位，按防封号策略休息约 ${Math.round(restMs / 60000)} 分钟（模拟真人作业中断，降低风控风险）`,
              });
              await sleep(restMs);
              resetDeliveredSinceRest();
              useRuntimeLogsStore.getState().addChatLog({ level: 'info', stage: 'system', msg: '批次休息结束，继续自动沟通' });
            }
            await pacerNow().waitForSlot();
            const baseSec = Math.max(Number(nowCfg.betweenJobsSeconds) || 15, SAFETY_LIMITS.MIN_BETWEEN_JOBS_MS / 1000);
            await sleep(baseSec * 1000 * (0.7 + Math.random() * 0.6));

            const outcome = await chatJob(item);
            if (outcome === 'success') {
              sentCount += 1;
              if (nowCfg.requireSingleJobValidation && !nowCfg.singleJobValidationCompletedAt) {
                useSettingsStore.getState().setConfig({ singleJobValidationCompletedAt: Date.now() });
                useRuntimeLogsStore.getState().addChatLog({
                  level: 'warn',
                  stage: 'confirm',
                  msg: '🛡️ 首条自动沟通成功并已安全暂停：请核对沟通 HR、文字气泡与附件，确认无误后点击「开始批量沟通」继续。',
                });
                break;
              }
            } else if (outcome === 'stop') {
              stopAll = true;
              break;
            }
            await sleep(500 + Math.random() * 700);
          } finally {
            releaseDelivery(item.id, itemPlatformKey);
          }
        }
      } finally {
        // 仅当本运行仍是 currentRun 时才复位（原 busy/ownerRun 的配对检查被引用相等替代），
        // 避免 stop()→start() 或旧运行回写串台；token 单调递增，旧 run 的引用必然失配。
        if (currentRun === run) {
          currentRun = null;
          set({ activeChatId: null, chatRunning: false, progress: { index: 0, total: 0 } });
          useDataStore.getState().recomputeStats();
          if (!stopAll) {
            useRuntimeLogsStore.getState().addChatLog({
              level: sentCount > 0 ? 'success' : 'info',
              stage: 'system',
              msg: `🏁 后台批量沟通任务结束：本次成功沟通 ${sentCount} 个岗位。`,
            });
          }
        }
      }
    })();
  },

  chatOne: (item) => {
    if (currentRun || useAutoChatStore.getState().chatRunning) return;
    const run: EngineRun = { token: ++nextRunToken, processedIds: new Set<string>(), cancelRequested: false };
    currentRun = run;
    set({ chatRunning: true, activeChatId: item.id, progress: { index: 0, total: 1 } });
    void (async () => {
      try {
        await chatJob(item);
      } finally {
        if (currentRun === run) {
          currentRun = null;
          set({ activeChatId: null, chatRunning: false, progress: { index: 0, total: 0 } });
          useDataStore.getState().recomputeStats();
        }
      }
    })();
  },

  setWatch: (on: boolean) => {
    if (on) {
      if (currentWatch || useAutoChatStore.getState().watchRunning) return;
      watchSeq += 1;
      const run: WatchRun = { token: ++nextRunToken, seq: watchSeq, cancelRequested: false };
      currentWatch = run;
      set({ watchRunning: true, watchActiveId: null });
      watchLoop(run);
      return;
    }
    // 关闭：置取消信号并立刻通知 Python 关闭常驻会话（loop 退出时按代际判断是否再关一次）
    if (currentWatch) {
      currentWatch.cancelRequested = true;
      currentWatch = null;
      set({ watchRunning: false, watchActiveId: null });
      void camoufoxChatWatch('stop').catch(() => undefined);
      useRuntimeLogsStore.getState().addChatLog({
        level: 'warn',
        stage: 'system',
        msg: '⏹ 已停止 AI 跟聊监听（常驻会话页已关闭）。',
      });
    }
  },

  stop: () => {
    // 作废进行中的批量循环并释放互斥（currentRun = null；token 单调递增无需额外递增）
    const run = currentRun;
    if (run) run.cancelRequested = true; // P04：通知进行中的发送取消（发送前检查，已发出则无法撤回）
    currentRun = null;
    // 同时停止「AI 跟聊监听」并关闭常驻会话页（同一停止按钮覆盖两个后台任务）
    if (currentWatch) {
      currentWatch.cancelRequested = true;
      currentWatch = null;
      void camoufoxChatWatch('stop').catch(() => undefined);
    }
    set({ chatRunning: false, watchRunning: false, activeChatId: null, watchActiveId: null, progress: { index: 0, total: 0 } });
    useRuntimeLogsStore.getState().addChatLog({
      level: 'warn',
      stage: 'system',
      msg: '⏹ 用户手动停止了后台自动沟通任务（批量沟通 / AI 跟聊监听）。',
    });
  },
}));