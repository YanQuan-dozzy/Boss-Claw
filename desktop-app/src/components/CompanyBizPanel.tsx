// components/CompanyBizPanel.tsx —— 岗位卡里的「企业工商信息」（P1-5 A 层）
//
// 为什么做成独立组件：工作台岗位卡已经有 3 个状态分支各一套按钮，把工商逻辑塞进 Workbench
// 会让那个 3200+ 行的文件再长一截；这里只做三件事 —— 展示已采字段 / 触发一次只读采集 / 明说没采到什么。
//
// 三条口径（改动前请先读）：
//   1. **只读公开信息**：数据来自用户自己打开的公司主页正文（`readPage` → page-read），不额外发请求；
//   2. **不参与投递判定**：这里不写 status、不改排序、不做「自动跳过」—— 提示只是提示；
//   3. **宁缺勿猜**：没采到的字段显式写「未采集」。空着会让人以为是「该企业没有这项」，
//      这是最容易被误读成结论的呈现方式。
import { useCallback, useState } from 'react';
import { Button, Tag, Tooltip } from 'antd';
import { CompanyBizProfile, bizProfileFresh, bizRiskHints, companyPageLike, parseCompanyBizProfile } from '@/lib/bossclaw/companyProfile';

export interface PageReadResult {
  url?: string;
  title?: string;
  bodyText?: string;
  /** 页面正文链接（preload page-read 新增）：企业背调 B 层靠它把信号挂到具体来源 */
  links?: Array<{ text?: string; href?: string }>;
  error?: string;
}

interface Props {
  company: string;
  /** 已采集的工商信息（缺失 = 从未采集） */
  profile?: CompanyBizProfile;
  /** 读取内置浏览器当前页面（工作台注入；内部走 preload 的 page-read，只读） */
  readPage: () => Promise<PageReadResult>;
  /** 采到后落库（写回 pending.job.companyProfile） */
  onSave: (profile: CompanyBizProfile) => void;
}

const ROWS: Array<{ key: keyof CompanyBizProfile['fields']; label: string }> = [
  { key: 'legalPerson', label: '法定代表人' },
  { key: 'registeredCapitalText', label: '注册资本' },
  { key: 'establishedAt', label: '成立日期' },
  { key: 'businessStatusText', label: '经营状态' },
  { key: 'creditCode', label: '统一社会信用代码' },
  { key: 'registeredAddress', label: '注册地址' },
  { key: 'insuredCountText', label: '参保人数' },
];

function fmtTime(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function CompanyBizPanel({ company, profile, readPage, onSave }: Props) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ type: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  const fresh = bizProfileFresh(profile);
  const hints = profile ? bizRiskHints(profile) : [];

  /** 解析不到字段时的引导文案：区分「页面不对」与「页面对但没展开区块」—— 否则用户只会看到一句没用的失败 */
  const describeMiss = (url: string): { type: 'warn'; text: string } => ({
    type: 'warn',
    text: companyPageLike(url)
      ? '当前公司主页里没有找到工商字段。请在公司主页展开「工商信息」区块（或等待其加载完成）后再读取一次。'
      : `当前页面不是公司主页（${url || '未知地址'}）。请先在岗位详情页点公司名打开公司主页，再点「读取当前页面」。`,
  });

  const handleRead = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const page = await readPage();
      if (!page || page.error) {
        setNotice({ type: 'error', text: `读取页面失败：${String(page?.error || '内置浏览器未就绪')}` });
        return;
      }
      const url = String(page.url || '');
      const parsed = parseCompanyBizProfile(String(page.bodyText || ''), { url, title: page.title });
      if (!parsed) {
        // 两种失败要分开说清楚：打错页面 vs 页面正确但没有工商区块（需手动展开）
        setNotice(describeMiss(url));
        return;
      }
      onSave(parsed);
      setNotice({
        type: 'ok',
        text: companyPageLike(url)
          ? `已从公司主页读取 ${Object.keys(parsed.fields).filter((k) => k !== 'businessStatus').length} 个字段`
          : `已从当前页面读取 ${Object.keys(parsed.fields).filter((k) => k !== 'businessStatus').length} 个字段（当前页不是公司主页，结果仅供参考）`,
      });
    } catch (e) {
      setNotice({ type: 'error', text: `读取异常：${String((e as Error)?.message || e)}` });
    } finally {
      setBusy(false);
    }
  }, [readPage, onSave, describeMiss]);

  return (
    <div className="company-biz" style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>企业工商</span>
        {profile ? (
          <>
            <Tag color={profile.fields.businessStatus === 'cancelled' || profile.fields.businessStatus === 'revoked' ? 'red' : 'blue'} style={{ margin: 0 }}>
              {profile.fields.businessStatusText || '状态未知'}
            </Tag>
            {!fresh && (
              <Tooltip title="工商信息超过 30 天，可能已变更；重新读取即可覆盖">
                <Tag style={{ margin: 0 }}>数据较旧</Tag>
              </Tooltip>
            )}
          </>
        ) : (
          <Tag style={{ margin: 0 }}>未采集</Tag>
        )}
        <Tooltip title="数据来自招聘平台公司主页本身（只读公开信息），只做提示，不影响是否投递、不改变岗位状态与排序">
          <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>仅提示，不参与投递判定</span>
        </Tooltip>
        <div style={{ marginLeft: 'auto' }}>
          <Button size="small" loading={busy} onClick={handleRead}>
            {profile ? '重新读取当前页面' : '读取当前页面'}
          </Button>
        </div>
      </div>

      {notice && (
        <div style={{ marginTop: 6, fontSize: 12, color: notice.type === 'error' ? 'var(--status-danger)' : notice.type === 'warn' ? 'var(--status-warning-strong)' : 'var(--status-success)' }}>
          {notice.text}
        </div>
      )}

      {profile ? (
        <>
          <div
            style={{
              marginTop: 8,
              display: 'grid',
              gridTemplateColumns: '104px 1fr',
              rowGap: 4,
              columnGap: 8,
              fontSize: 12,
            }}
          >
            {ROWS.map((row) => {
              const value = profile.fields[row.key];
              const missing = profile.missing.includes(row.label);
              return (
                <div key={row.key} style={{ display: 'contents' }}>
                  <span style={{ color: 'var(--fg-subtle)' }}>{row.label}</span>
                  <span style={{ color: missing ? 'var(--fg-subtle)' : undefined, wordBreak: 'break-all' }}>
                    {value ? String(value) : '未采集'}
                  </span>
                </div>
              );
            })}
          </div>

          {hints.length > 0 && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
              {hints.map((h) => (
                <li key={h.level + ':' + h.text} style={{ color: h.level === 'warn' ? 'var(--status-danger)' : 'var(--fg-muted)' }}>{h.text}</li>
              ))}
            </ul>
          )}

          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--fg-subtle)', wordBreak: 'break-all' }}>
            来源：{profile.sourceTitle || profile.sourceUrl || '公司主页'} · 采集于 {fmtTime(profile.parsedAt)}
          </div>
        </>
      ) : (
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--fg-subtle)' }}>
          尚未采集{company ? `「${company}」` : ''}的工商信息。请在内置浏览器打开该公司主页（岗位详情页点公司名），再点右上「读取当前页面」。
        </div>
      )}
    </div>
  );
}
