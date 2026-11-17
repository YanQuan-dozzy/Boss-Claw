// components/CompanyDueDiligencePanel.tsx —— 企业背调 B 层（负面信号）+ C 层（AI 评级）
//
// 与 A 层（CompanyBizPanel）合起来构成完整的「提示级背调」，但两者**都不参与投递判定**：
// 不写 status、不影响排序、不会自动跳过岗位。风险判断永远由用户做，这里只负责把事实摆清楚。
//
// 交互是「引导式」而非「自动爬」：
//   点搜索链接 / 官方核查入口 → 在内置浏览器打开（用户自己点，符合平台规则）→ 点「读取当前页」
//   → 从正文里提取负面信号（带原文片段与来源链）→ 有 AI 时再点「AI 评估」拿到可解释的评级。
// 每一步都可跳过：没搜索就只显示 A 层，没 AI 就只显示 A + B。
//
// 2026-11-17 优化：
//   · 多次读取改为**累积合并**（原来会用新页面覆盖旧证据），并显示已扫描页数；
//   · 官方核查入口（工商公示 / 信用中国 / 失信 / 被执行 / 裁判文书），打开前自动复制公司名；
//   · 来源分级、年份、同名待核实都直接标在信号行上；
//   · 增加确定性的「证据概况」，没有 API Key 也能判断证据强弱；
//   · 增加「复制报告」，把 A/B/C 三层拼成 Markdown，便于存档。
import { useCallback, useMemo, useState } from 'react';
import { Button, Dropdown, Tag, Tooltip } from 'antd';
import { useSettingsStore } from '@/store/useSettingsStore';
import {
  DueDiligenceRating, DueDiligenceScan, DueDiligenceState, RISK_LEVEL_LABEL, SOURCE_TIER_LABEL,
  appendScan, buildDueDiligenceReport, buildOfficialLinks, buildSearchLinks,
  distinctSourceCount, extractNegativeSignals, mergeSignals, rateCompany, ratingStale,
  signalCoverageNote, signalHeadline, sourceTierOf, summarizeSignals,
} from '@/lib/bossclaw/companyDueDiligence';
import type { CompanyBizProfile } from '@/lib/bossclaw/companyProfile';
import type { PageReadResult } from '@/components/CompanyBizPanel';

interface Props {
  company: string;
  /** A 层工商字段（C 层评级可引用编号 A） */
  biz?: CompanyBizProfile;
  state?: DueDiligenceState;
  /** 在内置浏览器新标签打开（搜索页 / 来源链 / 官方核查页） */
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
  const aiKeyReady = useSettingsStore((s) => Boolean(s.config.model?.apiKey));

  const signals = useMemo(() => state?.signals || [], [state]);
  const current = state?.rating;
  const stale = useMemo(() => ratingStale(state), [state]);
  const searchLinks = useMemo(() => buildSearchLinks(company), [company]);
  const officialLinks = useMemo(() => buildOfficialLinks(company), [company]);
  const stats = useMemo(() => summarizeSignals(signals), [signals]);
  // 兼容旧数据：只有 state.scan、没有 scans 时，把它当成一条扫描记录展示
  const scans = useMemo<DueDiligenceScan[]>(() => {
    if (state?.scans?.length) return state.scans;
    if (state?.scan) {
      return [{
        url: state.scan.url,
        title: state.scan.title,
        scannedAt: state.scan.scannedAt,
        hits: signals.length,
        added: signals.length,
      }];
    }
    return [];
  }, [state, signals.length]);
  const lastScan = scans.length ? scans[scans.length - 1] : undefined;
  const scanTooltip = scans.length
    ? scans.slice(-6).map((s) => `${fmtTime(s.scannedAt)} · 命中 ${s.hits} / 新增 ${s.added} · ${s.url}`).join('\n')
    : '还没有读取过页面';

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
        company,
      });
      // 累积合并：新页面没命中时，之前从别的页面找到的证据仍然保留
      const merged = mergeSignals(signals, found);
      // 合并有上限（默认 24 条），极端情况下可能挤掉旧信号；净增量按 0 兜底，避免出现「新增 -2 条」
      const added = Math.max(0, merged.length - signals.length);
      const scannedAt = Date.now();
      const scansNext = appendScan(scans, { url, title: page.title, scannedAt, hits: found.length, added });
      // 只替换信号与扫描记录，**不删旧评级**：旧评级可能仍成立，UI 会按 ratingStale 标「依据已变化，可重算」
      onSave({
        ...(state || {}),
        signals: merged,
        scans: scansNext,
        scan: { url, title: page.title, scannedAt },
      });
      setNotice(
        found.length
          ? { type: 'ok', text: `本次命中 ${found.length} 条，新增 ${added} 条；累计 ${merged.length} 条（来自 ${distinctSourceCount(merged)} 个来源）` }
          : { type: 'warn', text: `当前页没有命中负面关键词，之前找到的 ${merged.length} 条仍保留。若页面是搜索结果页，确认结果已加载完整后再读一次。` }
      );
    } catch (e) {
      setNotice({ type: 'error', text: `读取异常：${String((e as Error)?.message || e)}` });
    } finally {
      setBusy(false);
    }
  }, [readPage, onSave, state, signals, scans, company]);

  const handleRate = useCallback(async () => {
    setRating(true);
    setNotice(null);
    try {
      const model = useSettingsStore.getState().config.model;
      const result: DueDiligenceRating = await rateCompany({ company, biz, signals, config: model });
      onSave({ ...(state || { signals }), signals, rating: result });
      setNotice({ type: 'ok', text: '已生成评级（依据已挂来源；提供原文引用的已逐字校验）' });
    } catch (e) {
      setNotice({ type: 'error', text: String((e as Error)?.message || e) });
    } finally {
      setRating(false);
    }
  }, [company, biz, signals, state, onSave]);

  /** 官方站点都带验证码/JS 表单，不能直达查询：先复制公司名，再打开站点 */
  const handleOfficial = useCallback(async (url: string) => {
    let copied = false;
    try {
      if (company && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(company);
        copied = true;
      }
    } catch { /* 剪贴板不可用不影响打开页面 */ }
    openUrl(url, `官方核查：${company || '公司'}`);
    setNotice({
      type: copied ? 'ok' : 'warn',
      text: copied
        ? '已复制公司名，打开后在站内搜索框粘贴查询'
        : '已打开官方核查页；剪贴板不可用，请手动复制公司名查询',
    });
  }, [company, openUrl]);

  const handleCopyReport = useCallback(async () => {
    const report = buildDueDiligenceReport({ company, biz, state });
    try {
      if (!navigator.clipboard?.writeText) throw new Error('当前环境不支持剪贴板');
      await navigator.clipboard.writeText(report);
      setNotice({ type: 'ok', text: '背调报告已复制到剪贴板（Markdown）' });
    } catch (e) {
      setNotice({ type: 'error', text: `复制失败：${String((e as Error)?.message || e)}` });
    }
  }, [company, biz, state]);

  const officialMenu = {
    items: officialLinks.map((link) => ({
      key: link.key,
      label: (
        <div style={{ maxWidth: 360, whiteSpace: 'normal', lineHeight: 1.45 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>{link.label}</div>
          <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{link.hint}</div>
        </div>
      ),
    })),
    onClick: ({ key }: { key: string }) => {
      const link = officialLinks.find((item) => item.key === key);
      if (link) void handleOfficial(link.url);
    },
  };

  return (
    <div className="company-dd" style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>负面信号</span>
        {signals.length ? <Tag color="orange" style={{ margin: 0 }}>{signals.length} 条</Tag> : <Tag style={{ margin: 0 }}>未扫描</Tag>}
        {scans.length > 0 && (
          <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{scanTooltip}</span>}>
            <Tag style={{ margin: 0 }}>已扫描 {scans.length} 页</Tag>
          </Tooltip>
        )}
        <Tooltip title="搜索 / 官方核查都由你在内置浏览器里正常打开，再读取当前页正文 —— 不做自动抓取、不绕过验证码；信号只是关键词命中，需自己看片段判断">
          <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>只提示，不参与投递判定</span>
        </Tooltip>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Dropdown menu={officialMenu} trigger={['click']} overlayStyle={{ maxWidth: 400 }}>
            <Button size="small">官方核查</Button>
          </Dropdown>
          {searchLinks.map((l) => (
            <Tooltip key={l.label} title={l.query}>
              <Button size="small" onClick={() => openUrl(l.url, `搜索：${company}`)}>搜索{l.label}</Button>
            </Tooltip>
          ))}
          <Button size="small" loading={busy} onClick={handleScan}>读取当前页</Button>
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

      {(signals.length > 0 || scans.length > 0) && (
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 11 }}>
          {stats.high > 0 && <Tag color="red" style={{ margin: 0 }}>高权重 {stats.high}</Tag>}
          {stats.medium > 0 && <Tag color="orange" style={{ margin: 0 }}>中权重 {stats.medium}</Tag>}
          {stats.officialSources > 0 && <Tag color="blue" style={{ margin: 0 }}>官方来源 {stats.officialSources}</Tag>}
          {stats.identityUnclear > 0 && (
            <Tooltip title="这些片段里没有出现公司名，可能是在说同名企业；AI 评级会把它们降级为「需核实」">
              <Tag color="gold" style={{ margin: 0 }}>同名待核实 {stats.identityUnclear}</Tag>
            </Tooltip>
          )}
          {stats.stale > 0 && (
            <Tooltip title="两年前（含）的报道只能作线索，不能单独支撑高风险">
              <Tag style={{ margin: 0 }}>旧信息 {stats.stale}</Tag>
            </Tooltip>
          )}
          <span style={{ color: 'var(--fg-subtle)' }}>{signalCoverageNote(stats)}</span>
        </div>
      )}

      {signals.length > 0 && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 0, listStyle: 'none', fontSize: 12, lineHeight: 1.7 }}>
          {signals.map((s) => (
            <li key={s.id} style={{ marginBottom: 6 }}>
              <Tag color={WEIGHT_COLOR[s.weight]} style={{ marginRight: 6 }}>{s.label}</Tag>
              {s.year != null && <Tag style={{ marginRight: 6 }}>{s.year} 年</Tag>}
              {s.identity === 'unclear' && (
                <Tooltip title="片段里没有出现公司名，可能是在说同名企业，需人工核实">
                  <Tag color="gold" style={{ marginRight: 6 }}>同名待核实</Tag>
                </Tooltip>
              )}
              <span style={{ color: 'var(--fg-muted)' }}>{s.snippet}</span>
              <div style={{ fontSize: 11, color: 'var(--fg-subtle)', wordBreak: 'break-all' }}>
                {s.id} · {SOURCE_TIER_LABEL[s.tier || sourceTierOf(s.sourceUrl)]} · {signalHeadline(s)}
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
        {!aiKeyReady && <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>未配置 API Key：可点「AI 评估」尝试外部 agent，仍失败请到设置页配置</span>}
        {!signals.length && <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>先打开搜索/官方页并点「读取当前页」，拿到至少一条负面信号后才能评估</span>}
        {current && stale && (
          <Tooltip title="负面信号集合已变化（新增或减少），或评级超过 30 天；可重新评估">
            <Tag style={{ margin: 0 }}>依据已变化</Tag>
          </Tooltip>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Tooltip title="把工商字段、负面信号与证据概况拼成 Markdown，便于存档或发给朋友一起看">
            <Button size="small" onClick={handleCopyReport} disabled={!company}>复制报告</Button>
          </Tooltip>
          <Tooltip title={aiKeyReady ? '把工商字段与负面信号（含来源编号、层级、年份）交给模型；依据必须挂来源，引用原文会尽量逐字校验' : '未配置 API Key 时会尝试外部 agent 代答；仍不可用请到设置页配置。已有工商字段与负面信号不受影响'}>
            <Button size="small" type="primary" ghost loading={rating} disabled={!signals.length} onClick={handleRate}>
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
                {r.quote && (
                  <div style={{ fontSize: 11, color: 'var(--fg-subtle)', lineHeight: 1.5 }}>引用原文：「{r.quote}」</div>
                )}
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--fg-subtle)' }}>
            非权威结论，仅供筛选参考 · {current.model ? `${current.model} · ` : ''}评估于 {fmtTime(current.createdAt)}
            {lastScan?.url ? ` · 最近读取 ${lastScan.url}` : ''}
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
