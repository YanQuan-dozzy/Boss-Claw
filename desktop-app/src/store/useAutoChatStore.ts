// 全局「自动沟通」后台引擎（跨页面持久运行）
// ---------------------------------------------------------
// 原 useAutoChatEngine 是组件钩子：切页后组件卸载，批量任务随之丢失。
// 这里把运行器提升为模块级单例（Zustand store），使「开始批量沟通」后即使切到工作台，
// 任务仍在后台继续运行；同时运行器每个周期重新读取 pending，
// 工作台新批准的岗位会自动进入当前批次的自动沟通队列（无需重新点「开始」）。
//
// 安全不变量与旧实现一致：冷却/每日上限/早中晚分批/限速/首条验收/风控交人工均保留。
import { create } from 'zustand';
import { useDataStore } from '@/store/useDataStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import {
  camoufoxChat, camoufoxRestart, isCamoufoxStopCode, isCamoufoxEnvCode,
  type CamoufoxChatResult,
} from '@/lib/bossclaw/camoufox';
import {
  ActionPacer, effectiveDailyCap, dailySentCount, isLockedOut,
  cooldownRemaining, SAFETY_LIMITS,
} from '@/lib/bossclaw/safety';
import { cleanTitle } from '@/lib/bossclaw/jobDisplay';
import { getErrorMessage } from '@/lib/bossclaw/helpers';
import { activeBatchSlot } from '@/lib/bossclaw/batchSchedule';
import { generateReply } from '@/lib/bossclaw/greetings';
import { rerankPending } from '@/lib/bossclaw/priority';
import { claimDelivery, isDeliveryClaimed, releaseDelivery } from '@/lib/bossclaw/deliveryLock';
import type { PendingItem, ImageResume } from '@/lib/bossclaw/types';

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
let pacer = new ActionPacer(SAFETY_LIMITS.MAX_ACTIONS_PER_MINUTE);
let runToken = 0; // 递增即作废进行中的批量（start/stop）
let busy = false; // 批量与单条互斥
let ownerRun = 0; // 当前持有 busy 的 run token（避免 stop 后再 start 时被旧运行误清）
let processedIds: Set<string> = new Set(); // 本次运行已处理/已取走的岗位 id
// P04：stop() 置位的发送取消信号。chatJob 在真正调用网络发送（camoufoxChat）前检查，
// 已取消则不再发送、不计成功。start()/chatOne() 启动时复位。
let cancelRequested = false;

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
  jobTitle: string
): Promise<{ result: CamoufoxChatResult; dead: boolean }> {
  let result = await send();
  if (!looksEngineDown(result)) return { result, dead: false };
  for (let i = 1; i <= MAX_ENGINE_RESTART; i += 1) {
    useDataStore.getState().addChatLog({
      level: 'warn',
      stage: 'system',
      jobTitle,
      msg: `⚠️ 检测到 Camoufox 引擎异常，正在重启（第 ${i}/${MAX_ENGINE_RESTART} 次）...`,
      errorDetail: String(result?.error || result?.message || ''),
    });
    let ready = false;
    try {
      const st = await camoufoxRestart();
      ready = Boolean(st?.ready);
    } catch {
      ready = false;
    }
    await sleep(ENGINE_RESTART_WAIT_MS);
    if (ready) {
      useDataStore.getState().addChatLog({
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
  const { updatePending, addLog, addChatLog } = useDataStore.getState();
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
    // P04：真正发送前检查取消信号——已用户停止，则不发送、不计成功，保留岗位待下次恢复
    if (cancelRequested) {
      addChatLog({ level: 'warn', stage: 'system', jobId, jobTitle: title, company, msg: '⏹ 已取消发送（用户已停止），岗位保留待下次恢复' });
      return 'stop';
    }
    const resumeImages: { name: string; data: string }[] = cfg.sendResumeImage
      ? (useDataStore.getState().imageResumes as ImageResume[]).map((r) => ({ name: r.name, data: r.data }))
      : [];
    const baseOpts = {
      os: cfg.camoufox?.os,
      sendResumeImage: Boolean(cfg.sendResumeImage),
      sendOnlineResume: Boolean(cfg.sendOnlineResume),
      recruiterName: item.job?.recruiterName || '',
      company: item.job?.company || '',
      jobTitle: item.job?.title || '',
      resumeImages,
    };
    const initial = await chatWithEngineRecovery(() => camoufoxChat(jobId, greeting, baseOpts), title);
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

    // 外部网申岗位：不能自动沟通，标记跳过（对齐 job-claw externalApplicationInfo / 优先级 -6000）
    if (result.external || result.code === 600) {
      updatePending(item.id, { status: 'skipped', error: '外部网申岗位，跳过', retryable: false });
      addChatLog({
        level: 'warn',
        stage: 'skip',
        jobId,
        jobTitle: title,
        company,
        msg: '外部网申岗位，无法在 BOSS 聊天中自动沟通，已跳过（不加成功计数）',
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

    // HR 已发来消息 →「AI 跟聊」（对齐 AI-BossJob aiReply）：生成回复并以回复文本发送
    if (result.needsReply) {
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
          title
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
      }

    if (result.ok && result.sent) {
      updatePending(item.id, { status: 'sent', error: '', sentAt: Date.now() });

      addChatLog({
        level: 'success',
        stage: 'confirm',
        jobId,
        jobTitle: title,
        company,
        msg: `沟通成功！文字气泡已确认发送（模式：${result.method === 'browser-chat' ? '浏览器真实交互' : result.method || 'ok'}）`,
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
    useDataStore.getState().addChatLog({
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

interface AutoChatState {
  chatRunning: boolean;
  activeChatId: string | null;
  progress: AutoChatProgress;
  /** 启动后台批量沟通：持续处理当前队列，并自动接收工作台新批准岗位 */
  start: () => void;
  /** 仅处理单个岗位（不与批量并发） */
  chatOne: (item: PendingItem) => void;
  /** 停止后台任务 */
  stop: () => void;
}

export const useAutoChatStore = create<AutoChatState>((set) => ({
  chatRunning: false,
  activeChatId: null,
  progress: { index: 0, total: 0 },

  start: () => {
    if (busy || useAutoChatStore.getState().chatRunning) return;
    busy = true;
    runToken += 1;
    cancelRequested = false; // P04：复位取消信号
    const myToken = runToken;
    ownerRun = myToken;
    const cfg = useSettingsStore.getState().config;
    const pacerMax = Math.max(1, Number(cfg.maxActionsPerMinute) || SAFETY_LIMITS.MAX_ACTIONS_PER_MINUTE);
    if (pacer.budget !== pacerMax) pacer = new ActionPacer(pacerMax);
    processedIds = new Set();
    set({ chatRunning: true, activeChatId: null, progress: { index: 0, total: 0 } });
    useDataStore.getState().addChatLog({
      level: 'info',
      stage: 'system',
      msg: '🚀 批量自动沟通已在后台启动：持续处理当前队列，并会在工作台新批准岗位时自动加入继续沟通（切到工作台仍会继续运行）。',
    });

    void (async () => {
      let sentCount = 0;
      let stopAll = false;
      let greeted = false;
      try {
        while (runToken === myToken) {
          const data = useDataStore.getState();
          const eligible = rerankPending(data.pending).filter(
            (p: PendingItem) => BATCH_ELIGIBLE.includes(p.status) && !processedIds.has(p.id) && !isDeliveryClaimed(p.id)
          );

          // 队列暂空 → 后台轮询，等待工作台新批准岗位
          if (eligible.length === 0) {
            if (!greeted) {
              greeted = true;
              useDataStore.getState().addChatLog({
                level: 'info',
                stage: 'system',
                msg: '👀 当前后台队列已处理完。任务保持运行，工作台新批准的岗位会自动进入沟通队列。',
              });
            }
            set({ progress: { index: processedIds.size, total: processedIds.size } });
            await sleep(IDLE_POLL_MS);
            continue;
          }

          const item = eligible[0];

          // —— 消费前守卫（P03：冷却/每日上限/分批窗口这些非「实际发送」的判定，
          //    必须在 claimDelivery + processedIds.add 之前执行，否则会把整队列预占却一条不发，
          //    窗口打开后这些岗位已被 processedIds 排除 → 永久空轮询）——
          const nowCfg = useSettingsStore.getState().config;
          // B1：冷却/每日上限/首条验收/风控这些内部退出路径不再自增 runToken 使 isCurrent=false，
          //    直接 break 由 finally 正常复位 chatRunning（否则 chatRunning 卡死、start() 被拦死）。
          if (isLockedOut(nowCfg)) {
            useDataStore.getState().addChatLog({
              level: 'warn',
              stage: 'risk',
              msg: `账号处于安全冷却期，后台沟通已暂停（剩余约 ${Math.ceil(cooldownRemaining(nowCfg) / 60000)} 分钟）。点击「停止」后可稍后重试。`,
            });
            break;
          }
          if (dailySentCount(useDataStore.getState().pending) >= effectiveDailyCap(nowCfg)) {
            useDataStore.getState().addChatLog({
              level: 'warn',
              stage: 'risk',
              msg: `今日沟通数已触及安全上限 ${effectiveDailyCap(nowCfg)} 条，后台沟通已暂停。`,
            });
            break;
          }
          if (nowCfg.executionMode === 'auto' && nowCfg.batchDelivery?.enabled) {
            const slot = activeBatchSlot(nowCfg, Date.now(), useDataStore.getState().pending);
            if (!slot) {
              useDataStore.getState().addChatLog({
                level: 'warn',
                stage: 'system',
                msg: `⏱ 当前不在早中晚分批投递的时段窗口内（早 ${nowCfg.batchDelivery.morningTime} / 午 ${nowCfg.batchDelivery.noonTime} / 晚 ${nowCfg.batchDelivery.eveningTime}），后台任务等待下一时段。`,
              });
              await sleep(IDLE_POLL_MS);
              continue;
            }
            if (slot.remaining <= 0) {
              useDataStore.getState().addChatLog({
                level: 'warn',
                stage: 'system',
                msg: `⏱ 「${slot.label}」时段投递配额（${slot.quota} 条）已用完，后台任务等待下一时段。`,
              });
              await sleep(IDLE_POLL_MS);
              continue;
            }
          }

          // 走到这里才真正要发送 → 才认领占位锁并记入 processedIds（B1/P03）
          if (!claimDelivery(item.id)) {
            // 已被其他引擎认领投递，本轮跳过（交给认领方），下周期若被释放则重新纳入
            continue;
          }
          processedIds.add(item.id);
          set({ activeChatId: item.id, progress: { index: processedIds.size, total: processedIds.size + eligible.length } });
          try {
            await pacer.waitForSlot();
            const baseSec = Math.max(Number(nowCfg.betweenJobsSeconds) || 15, SAFETY_LIMITS.MIN_BETWEEN_JOBS_MS / 1000);
            await sleep(baseSec * 1000 * (0.7 + Math.random() * 0.6));

            const outcome = await chatJob(item);
            if (outcome === 'success') {
              sentCount += 1;
              if (nowCfg.requireSingleJobValidation && !nowCfg.singleJobValidationCompletedAt) {
                useSettingsStore.getState().setConfig({ singleJobValidationCompletedAt: Date.now() });
                useDataStore.getState().addChatLog({
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
            releaseDelivery(item.id);
          }
        }
      } finally {
        const isCurrent = runToken === myToken;
        if (isCurrent) runToken += 1;
        // 仅当本运行仍持有 busy 时才释放，避免 stop()→start() 或旧运行回写串台
        if (ownerRun === myToken) {
          ownerRun = 0;
          busy = false;
        }
        if (isCurrent) {
          set({ activeChatId: null, chatRunning: false, progress: { index: 0, total: 0 } });
          useDataStore.getState().recomputeStats();
          if (!stopAll) {
            useDataStore.getState().addChatLog({
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
    if (busy || useAutoChatStore.getState().chatRunning) return;
    busy = true;
    cancelRequested = false; // P04：复位取消信号
    const myToken = (runToken += 1);
    ownerRun = myToken;
    set({ chatRunning: true, activeChatId: item.id, progress: { index: 0, total: 1 } });
    void (async () => {
      try {
        await chatJob(item);
      } finally {
        if (ownerRun === myToken) {
          ownerRun = 0;
          busy = false;
        }
        if (runToken === myToken) {
          set({ activeChatId: null, chatRunning: false, progress: { index: 0, total: 0 } });
          useDataStore.getState().recomputeStats();
        }
      }
    })();
  },

  stop: () => {
    runToken += 1; // 作废进行中的批量循环
    cancelRequested = true; // P04：通知进行中的发送取消（发送前检查，已发出则无法撤回）
    if (ownerRun !== 0) {
      ownerRun = 0;
      busy = false;
    }
    set({ chatRunning: false, activeChatId: null, progress: { index: 0, total: 0 } });
    useDataStore.getState().addChatLog({
      level: 'warn',
      stage: 'system',
      msg: '⏹ 用户手动停止了后台自动沟通任务。',
    });
  },
}));