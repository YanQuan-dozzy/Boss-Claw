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
  camoufoxChat, camoufoxRestart, isCamoufoxStopCode, isCamoufoxEnvCode,
  type CamoufoxChatResult,
} from '@/lib/bossclaw/camoufox';
import {
  ActionPacer, effectiveDailyCap, effectiveDailyCapFor, dailySentCount, dailySentCountFor,
  isLockedOut, cooldownRemaining, SAFETY_LIMITS,
} from '@/lib/bossclaw/safety';
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
let pacer = new ActionPacer(SAFETY_LIMITS.MAX_ACTIONS_PER_MINUTE); // 跨 run 共享的动作节流器（预算重置在 start()）

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

    // HR 已发来消息 →「AI 跟聊」（对齐 AI-BossJob aiReply）：生成回复并以回复文本发送。
    // 仅 BOSS 聊天链路支持（其余平台回复在平台 App 内人工跟进）
    if (platform === 'boss' && result.needsReply) {
      const hrMessage = String(result.hrLastMessage || '').trim();
      addChatLog({
        level: 'stage',
        stage: 'ai_reply',
        jobId,
        jobTitle: title,
        company,
        msg: '检测到 HR 已发来消息，正在生成 AI 回复...',
        errorDetail: hrMessage ? `HR 消息：${hrMessage.slice(0, 200)}` : '',
      });
      const reply = await generateReply({
        hrMessage,
        jobTitle: item.job?.title || '',
        resumeText: useDataStore.getState().resumeText,
        profile: useDataStore.getState().profile,
        communicationInfo: useDataStore.getState().communicationInfo,
        model: useSettingsStore.getState().config.model,
      });
      if (!reply.text) {
        updatePending(item.id, { status: 'failed', error: 'HR 已回复但无法生成 AI 回复', retryable: true });
        addChatLog({ level: 'error', stage: 'ai_reply', jobId, jobTitle: title, company, msg: 'AI 回复生成失败，已暂停该条' });
        return 'failed';
      }
      addChatLog({
        level: reply.method === 'ai' ? 'info' : 'warn',
        stage: 'ai_reply',
        jobId,
        jobTitle: title,
        company,
        msg: reply.method === 'ai' ? `AI 回复已生成：${reply.text.slice(0, 60)}...` : (reply.warning || 'AI 回复已生成'),
        errorDetail: reply.text,
      });
      const replySend = await chatWithEngineRecovery(
          async () => camoufoxChat(jobId, reply.text, { ...baseOpts, mode: 'reply', replyText: reply.text }),
          title, platform
        );
        if (replySend.dead) {
          updatePending(item.id, { status: 'failed', error: 'Camoufox 引擎多次重启失败，自动沟通已停止', retryable: true });
          addChatLog({
            level: 'error',
            stage: 'system',
            jobId,
            jobTitle: title,
            company,
            msg: '❌ 发送 AI 回复时 Camoufox 引擎多次重启失败，自动沟通已自动停止',
            errorDetail: '请检查引擎/登录态后重试。',
          });
          addLog('error', `发送 AI 回复时引擎多次重启失败，自动沟通已停止：${title}`);
          return 'stop';
        }
        result = replySend.result;
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
      useSettingsStore.getState().setConfig({ pausedUntil: Date.now() + SAFETY_LIMITS.DEFAULT_COOLDOWN_MS });
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
  activeChatId: string | null;
  progress: AutoChatProgress;
  /** 启动后台批量沟通：持续处理当前队列，并自动接收工作台新批准岗位 */
  start: (scope?: AutoChatScope) => void;
  /** 仅处理单个岗位（不与批量并发） */
  chatOne: (item: PendingItem) => void;
  /** 停止后台任务 */
  stop: () => void;
}

export const useAutoChatStore = create<AutoChatState>((set) => ({
  chatRunning: false,
  activeChatId: null,
  progress: { index: 0, total: 0 },

  start: (scope?: AutoChatScope) => {
    if (currentRun || useAutoChatStore.getState().chatRunning) return;
    const run: EngineRun = { token: ++nextRunToken, processedIds: new Set<string>(), cancelRequested: false };
    currentRun = run; // 建立互斥（busy）：单一真值，null = 空闲
    const cfg = useSettingsStore.getState().config;
    const pacerMax = Math.max(1, Number(cfg.maxActionsPerMinute) || SAFETY_LIMITS.MAX_ACTIONS_PER_MINUTE);
    if (pacer.budget !== pacerMax) pacer = new ActionPacer(pacerMax);
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
            await pacer.waitForSlot();
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

  stop: () => {
    // 作废进行中的批量循环并释放互斥（currentRun = null；token 单调递增无需额外递增）
    const run = currentRun;
    if (run) run.cancelRequested = true; // P04：通知进行中的发送取消（发送前检查，已发出则无法撤回）
    currentRun = null;
    set({ chatRunning: false, activeChatId: null, progress: { index: 0, total: 0 } });
    useRuntimeLogsStore.getState().addChatLog({
      level: 'warn',
      stage: 'system',
      msg: '⏹ 用户手动停止了后台自动沟通任务。',
    });
  },
}));