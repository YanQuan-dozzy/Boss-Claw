// 内置浏览器「便签页 / 空白标签页」—— 白名单招聘平台快捷入口 + 受限地址输入。
// 仅展示白名单内的招聘平台，输入框导航同样受白名单约束（BrowserView 的 userNavigate 负责拦截）。
import { useState } from 'react';
import { Button, Input, Tooltip } from 'antd';
import { GlobalOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import type { BrowserSite } from '@/lib/bossclaw/browserWhitelist';

export interface NewTabGroup {
  label: string;
  sites: BrowserSite[];
}

interface Props {
  /** 白名单分组快捷卡片（含按启用状态过滤后的「平台」分组） */
  groups: NewTabGroup[];
  /** 点击某平台卡片 → 在该空白标签加载平台首页 */
  onOpenSite: (site: BrowserSite) => void;
  /** 顶部地址输入回车/前往 → 交给 userNavigate 做白名单校验 */
  onNavigate: (raw: string) => void;
}

export default function BrowserNewTabPage({ groups, onOpenSite, onNavigate }: Props) {
  const [value, setValue] = useState('');

  const go = () => {
    const raw = value.trim();
    if (!raw) return;
    onNavigate(raw);
  };

  return (
    <div className="browser-newtab-page">
      <div className="browser-newtab-head">
        <div className="browser-newtab-title">
          <GlobalOutlined style={{ fontSize: 16 }} />
          <span>招聘平台便签页</span>
        </div>
        <div className="browser-newtab-sub">
          <SafetyCertificateOutlined style={{ opacity: 0.6 }} />
          仅可访问白名单内的招聘平台，其它网址将被拦截
        </div>
      </div>

      <div className="browser-newtab-input-row">
        <Input
          size="large"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onPressEnter={go}
          allowClear
          placeholder="输入招聘平台网址，回车访问（如 zhipin.com / liepin.com）"
        />
        <Tooltip title="前往（仅限白名单招聘平台）">
          <Button size="large" type="primary" onClick={go} className="browser-newtab-input-btn">
            前往
          </Button>
        </Tooltip>
      </div>

      <div className="browser-newtab-groups">
        {groups.map((g) => (
          <div className="browser-newtab-group" key={g.label}>
            <div className="browser-newtab-group-label">{g.label}</div>
            {g.sites.length === 0 ? (
              <div className="browser-newtab-empty">该分组暂无可用平台</div>
            ) : (
              <div className="browser-newtab-cards">
                {g.sites.map((s) => (
                  <div
                    key={s.domain}
                    className="browser-newtab-card"
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenSite(s)}
                    onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onOpenSite(s); } }}
                    title={`打开 ${s.label}（${s.domain}）`}
                  >
                    <div className="browser-newtab-card-name">{s.label}</div>
                    <div className="browser-newtab-card-domain">{s.domain}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}