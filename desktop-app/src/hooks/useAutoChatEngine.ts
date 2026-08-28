import { useState, useRef, useCallback } from 'react';
import { useDataStore } from '@/store/useDataStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import {
  camoufoxChat, isCamoufoxStopCode, isCamoufoxEnvCode,
} from '@/lib/bossclaw/camoufox';
import {
  ActionPacer, effectiveDailyCap, dailySentCount, isLockedOut,
  cooldownRemaining, SAFETY_LIMITS,
} from '@/lib/bossclaw/safety';
import { cleanTitle } from '@/lib/bossclaw/jobDisplay';
import { getErrorMessage } from '@/lib/bossclaw/helpers';
import type { PendingItem } from '@/lib/bossclaw/types';

/** 从岗位元信息中提取纯 encryptJobId */
export function extractJobId(job: PendingItem['job']): string {
  const j = job || {};
  let jid = String(j.jobId || '').trim();
  const kv = jid.match(/(?:encryptJobId|jobId|securityId|lid)=([^&?#]+)/i);
  if (kv) jid = kv[1];
  jid = jid.replace(/\.html$/i, '').trim();
  if (jid && !/^https?:/i.test(jid)) return jid;
  const m = String(j.url || '').match(/job_detail\/([^/?#.]+)/i);
  return m ? m[1].replace(/\.html$/i, '') : '';
}

export type ChatJobOutcome = 'success' | 'failed' | 'stop' | 'continue';

export function useAutoChatEngine() {
  const [chatRunning, setChatRunning] = useState(false);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ index: number; total: number }>({ index: 0, total: 0 });

  const chatActiveRef = useRef(false);
  const pacerRef = useRef<ActionPacer>(new ActionPacer(SAFETY_LIMITS.MAX_ACTIONS_PER_MINUTE));

  const updatePending = useDataStore((s) => s.updatePending);
  const addLog = useDataStore((s) => s.addLog);
  const addChatLog = useDataStore((s) => s.addChatLog);
  const recomputeStats = useDataStore((s) => s.recomputeStats);

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /** 单条岗位沟通 */
  const chatJob = useCallback(async (item: PendingItem): Promise<ChatJobOutcome> => {
    const cfg = useSettingsStore.getState().config;
    const title = cleanTitle(item.job?.title);
    const company = item.job?.company || '';
    const greeting = String(item.deliveryGreeting || item.analysis?.greeting || '').trim();

    if (!greeting) {
      updatePending(item.id, { status: 'failed', error: '招呼语为空，无法自动沟通，请补充后再试', retryable: true });
      addChatLog({ level: 'error', stage: 'greeting', jobTitle: title, company, msg: `沟通中断：岗位招呼语为空`, errorDetail: '请编辑招呼语后重试' });
      return 'failed';
    }

    const jobId = extractJobId(item.job);
    if (!jobId) {
      updatePending(item.id, { status: 'failed', error: '岗位缺少 jobId，无法自动沟通', retryable: false });
      addChatLog({ level: 'error', stage: 'open_chat', jobTitle: title, company, msg: `沟通中断：岗位缺少 jobId 参数` });
      return 'failed';
    }

    // 阶段 1：打开沟通
    addChatLog({
      level: 'stage',
      stage: 'open_chat',
      jobId,
      jobTitle: title,
      company,
      msg: `唤起隐身浏览器，正在打开「${title} @ ${company}」沟通窗口...`,
    });

    // 阶段 2：招呼语准备
    addChatLog({
      level: 'info',
      stage: 'greeting',
      jobId,
      jobTitle: title,
      company,
      msg: `准备发送个性化招呼语 (${greeting.length}字)`,
      greetingPreview: greeting,
    });

    try {
      const result = await camoufoxChat(jobId, greeting, {
        os: cfg.camoufox?.os,
        sendResumeImage: Boolean(cfg.sendResumeImage),
        sendOnlineResume: Boolean(cfg.sendOnlineResume),
      });

      if (result.ok && result.sent) {
        updatePending(item.id, { status: 'sent', error: '', sentAt: Date.now() });

        // 阶段 3 & 4：确认气泡与简历附件
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
            msg: `附件状态：已触发在线简历/图片简历打包同步`,
          });
        }
        addLog('success', `自动沟通成功：${title}`);
        return 'success';
      }

      const code = result.code ?? null;
      const msg = String(result.message || result.error || '自动沟通失败');
      // 35（需人工安全验证）与 36/32（风控）同样属于「立即停止」级，绝不自动重试
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
      updatePending(item.id, { status: 'failed', error: msg, retryable: true });
      addChatLog({
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
  }, [updatePending, addLog, addChatLog]);

  /** 批量自动沟通流程 */
  const runBatchChat = useCallback(async (queue: PendingItem[]) => {
    if (chatActiveRef.current || !queue.length) return;

    chatActiveRef.current = true;
    setChatRunning(true);
    setProgress({ index: 0, total: queue.length });

    let sentCount = 0;
    const cfg = useSettingsStore.getState().config;
    const pacerMax = Math.max(1, Number(cfg.maxActionsPerMinute) || SAFETY_LIMITS.MAX_ACTIONS_PER_MINUTE);
    if (pacerRef.current.budget !== pacerMax) pacerRef.current = new ActionPacer(pacerMax);

    addChatLog({
      level: 'info',
      stage: 'system',
      msg: `🚀 开始批量自动沟通任务：队列中共 ${queue.length} 个确认岗位`,
    });

    let stopAll = false;
    for (let i = 0; i < queue.length; i += 1) {
      if (!chatActiveRef.current) break;
      const item = queue[i];
      setActiveChatId(item.id);
      setProgress({ index: i + 1, total: queue.length });

      // 冷却 / 每日上限 / 限速
      const nowCfg = useSettingsStore.getState().config;
      if (isLockedOut(nowCfg)) {
        addChatLog({
          level: 'warn',
          stage: 'risk',
          msg: `账号处于安全冷却期，暂停自动沟通（剩余约 ${Math.ceil(cooldownRemaining(nowCfg) / 60000)} 分钟）`,
        });
        break;
      }
      if (dailySentCount(useDataStore.getState().pending) >= effectiveDailyCap(nowCfg)) {
        addChatLog({
          level: 'warn',
          stage: 'risk',
          msg: `今日沟通数已触及安全上限 ${effectiveDailyCap(nowCfg)} 条，暂停后续代投`,
        });
        break;
      }
      await pacerRef.current.waitForSlot();
      const baseSec = Math.max(Number(nowCfg.betweenJobsSeconds) || 15, SAFETY_LIMITS.MIN_BETWEEN_JOBS_MS / 1000);
      await sleep(baseSec * 1000 * (0.8 + Math.random() * 0.4));

      const outcome = await chatJob(item);
      if (outcome === 'success') {
        sentCount += 1;
        // 首次成功投递后暂停验收（安全不变量）
        if (nowCfg.requireSingleJobValidation && !nowCfg.singleJobValidationCompletedAt) {
          useSettingsStore.getState().setConfig({ singleJobValidationCompletedAt: Date.now() });
          addChatLog({
            level: 'warn',
            stage: 'confirm',
            msg: '🛡️ 首条自动沟通成功并已安全暂停：请前往浏览器核对沟通 HR、文字气泡与附件，确认无误后可继续进行批量代投。',
          });
          break;
        }
      } else if (outcome === 'stop') {
        stopAll = true;
        break;
      }
      await sleep(800);
    }

    chatActiveRef.current = false;
    setActiveChatId(null);
    setChatRunning(false);
    setProgress({ index: 0, total: 0 });
    recomputeStats();
    if (!stopAll) {
      addChatLog({
        level: sentCount > 0 ? 'success' : 'info',
        stage: 'system',
        msg: `🏁 批量沟通任务结束：成功代投 ${sentCount} 个岗位`,
      });
    }
  }, [chatJob, addLog, addChatLog, recomputeStats]);

  /** 单岗位直接沟通 */
  const chatOne = useCallback(async (item: PendingItem) => {
    if (chatActiveRef.current) return;
    chatActiveRef.current = true;
    setChatRunning(true);
    setActiveChatId(item.id);
    await chatJob(item);
    chatActiveRef.current = false;
    setActiveChatId(null);
    setChatRunning(false);
    recomputeStats();
  }, [chatJob, recomputeStats]);

  /** 手动停止流程 */
  const stopChat = useCallback(() => {
    chatActiveRef.current = false;
    setChatRunning(false);
    setActiveChatId(null);
    setProgress({ index: 0, total: 0 });
    addChatLog({
      level: 'warn',
      stage: 'system',
      msg: '⏹ 用户手动停止了自动沟通任务',
    });
  }, [addChatLog]);

  return {
    chatRunning,
    activeChatId,
    progress,
    chatJob,
    chatOne,
    runBatchChat,
    stopChat,
  };
}
