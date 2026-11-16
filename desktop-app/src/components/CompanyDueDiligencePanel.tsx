// components/CompanyDueDiligencePanel.tsx —— 企业背调 B 层（负面信号）+ C 层（AI 评级）
//
// 与 A 层（CompanyBizPanel）合起来构成完整的「提示级背调」，但两者**都不参与投递判定**：
// 不写 status、不影响排序、不会自动跳过岗位。风险判断永远由用户做，这里只负责把事实摆清楚。
//
// 交互是「引导式」而非「自动爬」：
//   点搜索链接 → 在内置浏览器打开结果页（用户自己点，符合平台规则）→ 点「读取当前页」
//   → 从正文里提取负面信号（带原文片段与来源链）→ 有 AI 时再点「AI 评估」拿到可解释的评级。
// 每一步都可跳过：没搜索就只显示 A 层，没 AI 就只显示 A + B。
import { useCallback, useMemo, useState } from 'react';
import { Button, Space, Tag, Tooltip } from 'antd';
import { useSettingsStore } from '@/store/useSettingsStore';
import {
  DueDiligenceRating, DueDiligenceState, RISK_LEVEL_LABEL, buildSearchLinks,
  distinctSourceCount, extractNegativeSignals, rateCompany, ratingStale, signalHeadline,
} from '@/lib/bossclaw/companyDueDiligence';
import type { CompanyBizProfile } from '@/lib/bossclaw/companyProfile';
import type { PageReadResult } from '@/components/CompanyBizPanel';

interface Props {
  company: string;
  /** A 层工商字段（C 层评级可引用编号 A） */
  biz?: CompanyBizProfile;
  state?: DueDiligenceState;
  /** 在内置浏览器新标签打开（搜索页 / 来源链） */
  openUrl: (url: string, title?: string) => void;
  /** 读取内置浏览器当前页面（由工作台注入） */
  readPage: () => Promise<PageReadResult>;
  /** 落库（写回 pending.job.dueDiligence） */
  onSave: (state: DueDiligenceState) => void;
}

const LEVEL_COLOR: Record<string, string> = { low: 'green', medium: 'orange', high: 'red' };
const WEIGHT_COLOR: Record<number, string> = { 1: 'default', 2: 'orange', 3: 'red' };

function fmtTime(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function CompanyDueDiligencePanel({ company, biz, state, openUrl, readPage, onSave }: Props) {
  const [busy, setBusy] = useState(false);
  const [rating, setRating] = useState(false);
  const [notice, setNotice] = useState<{ type: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const aiReady = useSettingsStore((s) => Boolean(s.config.model?.apiKey));

  const signals = state?.signals || [];
  const current = state?.rating;
  const stale = useMemo(() => ratingStale(state), [state]);
  const searchLinks = useMemo(() => buildSearchLinks(company), [company]);

  const handleScan = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const page = await readPage();
      if (!page || page.error) {
        setNotice({ type: 'error', text: `读取页面失败：${String(page?.error || '内置浏览器未就绪')}` });
        return;
      }
      const url = String(page.url || '');
      const found = extractNegativeSignals(String(page.bodyText || ''), {
        url,
        title: page.title,
        links: Array.isArray(page.links) ? page.links : undefined,
      });
      // 只替换信号，**不删旧评级**：旧评级可能仍成立，UI 会按 ratingStale 标「依据已变化，可重算」
      onSave({ ...(state || {}), signals: found, scan: { url, title: page.title, scannedAt: Date.now() } });
      setNotice(
        found.length
          ? { type: 'ok', text: `命中 ${found.length} 条负面信号（来自 ${distinctSourceCount(found)} 个来源）` }
          : { type: 'warn', text: '当前页没有命中负面关键词。若页面是搜索结果页，确认结果已加载完整后再读一次。' }
      );
    } catch (e) {
      setNotice({ type: 'error', text: `读取异常：${String((e as Error)?.message || e)}` });
    } finally {
      setBusy(false);
    }
  }, [readPage, onSave, state]);

  const handleRate = useCallback(async () => {
    setRating(true);
    setNotice(null);
    try {
      const model = useSettingsStore.getState().config.model;
      const result: DueDiligenceRating = await rateCompany({ company, biz, signals, config: model });
      onSave({ ...(state || { signals }), signals, rating: result });
      setNotice({ type: 'ok', text: '已生成评级（每条依据都挂到了来源）' });
    } catch (e) {
      setNotice({ type: 'error', text: String((e as Error)?.message || e) });
    } finally {
      setRating(false);
    }
  }, [company, biz, signals, state, onSave]);

  return (
    <div className="company-dd" style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>负面信号</span>
        {signals.length ? <Tag color="orange" style={{ margin: 0 }}>{signals.length} 条</Tag> : <Tag style={{ margin: 0 }}>未扫描</Tag>}
        <Tooltip title="搜索由你在内置浏览器里正常打开，再读取当前页正文 —— 不做自动抓取、不绕过验证码；信号只是关键词命中，需自己看片段判断">
          <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>只提示，不参与投递判定</span>
        </Tooltip>
        <div style={{ marginLeft: 'auto' }}>
          <Space size={6}>
            {searchLinks.map((l) => (
              <Tooltip key={l.label} title={l.query}>
                <Button size="small" onClick={() => openUrl(l.url, `搜索：${company}`)}>搜索{l.label}</Button>
              </Tooltip>
            ))}
            <Button size="small" loading={busy} onClick={handleScan}>读取当前页</Button>
          </Space>
        </div>
      </div>

      {notice && (
        <div style={{
          marginTop: 6, fontSize: 12,
          color: notice.type === 'error' ? 'var(--status-danger)' : notice.type === 'warn' ? 'var(--status-warning-strong)' : 'var(--status-success)',
        }}>
          {notice.text}
        </div>
      )}

      {signals.length > 0 && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 0, listStyle: 'none', fontSize: 12, lineHeight: 1.7 }}>
          {signals.map((s) => (
            <li key={s.id} style={{ marginBottom: 6 }}>
              <Tag color={WEIGHT_COLOR[s.weight]} style={{ marginRight: 6 }}>{s.label}</Tag>
              <span style={{ color: 'var(--fg-muted)' }}>{s.snippet}</span>
              <div style={{ fontSize: 11, color: 'var(--fg-subtle)', wordBreak: 'break-all' }}>
                {s.id} · {signalHeadline(s)}
                {s.sourceUrl ? (
                  <Button type="link" size="small" style={{ padding: '0 4px', fontSize: 11, height: 18 }} onClick={() => openUrl(s.sourceUrl, s.sourceTitle || s.label)}>
                    打开来源
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>AI 评级</span>
        {current ? (
          <Tag color={LEVEL_COLOR[current.level]} style={{ margin: 0 }}>{RISK_LEVEL_LABEL[current.level]}</Tag>
        ) : (
          <Tag style={{ margin: 0 }}>未评级</Tag>
        )}
        {!aiReady && <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>未配置 AI API Key，仅展示工商字段与负面信号</span>}
        {current && stale && (
          <Tooltip title="负面信号集合已变化（新增或减少），或评级超过 30 天；可重新评估">
            <Tag style={{ margin: 0 }}>依据已变化</Tag>
          </Tooltip>
        )}
        <div style={{ marginLeft: 'auto' }}>
          <Tooltip title={aiReady ? '把工商字段与负面信号（含来源编号）交给模型，输出低/中/高 + 每条依据的来源；挂不上来源的依据会被丢弃' : '请先在设置页配置 AI API Key'}>
            <Button size="small" type="primary" ghost loading={rating} disabled={!aiReady || !signals.length} onClick={handleRate}>
              {current ? '重新评估' : 'AI 评估'}
            </Button>
          </Tooltip>
        </div>
      </div>

      {current ? (
        <>
          {current.summary && (
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--fg-muted)' }}>{current.summary}</div>
          )}
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
            {current.reasons.map((r) => (
              <li key={r.text} style={{ color: 'var(--fg-muted)' }}>
                {r.text}
                <span style={{ marginLeft: 6 }}>
                  {r.sources.map((s) => <Tag key={s} style={{ marginInlineEnd: 4, fontSize: 10 }}>{s}</Tag>)}
                </span>
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--fg-subtle)' }}>
            非权威结论，仅供筛选参考 · {current.model ? `${current.model} · ` : ''}评估于 {fmtTime(current.createdAt)}
            {state?.scan?.url ? ` · 信号来源 ${state.scan.url}` : ''}
          </div>
        </>
      ) : signals.length ? (
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--fg-subtle)' }}>
          已有负面信号但未评级。评级只做提示，不会改变岗位状态或投递顺序。
        </div>
      ) : null}
    </div>
  );
}
