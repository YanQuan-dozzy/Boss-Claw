import { memo, useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useDataStore } from '../store/useDataStore';
import { PLATFORM_IDS, PLATFORM_META } from '../lib/bossclaw/platforms';

export default memo(function StatusBar() {
  const bridge = useAppStore((s) => s.bridgeStatus);
  const platformLogins = useAppStore((s) => s.platformLogins);
  const pending = useDataStore((s) => s.pending);

  // 全平台登录汇总：已登录数 / 平台总数 + 已登录平台简称。
  // 全部未知（启动初期 / 探测异常）显示「检测中」，圆点照旧 绿=有已登录 / 红=全部未登录 / 灰=检测中。
  const loginInfo = useMemo(() => {
    const all = PLATFORM_IDS;
    const loggedIn = all.filter((p) => platformLogins[p] === true);
    const known = all.filter((p) => platformLogins[p] === true || platformLogins[p] === false);
    if (known.length === 0) return { dot: '', text: '登录 检测中' };
    const names = loggedIn.map((p) => PLATFORM_META[p].shortLabel).join('·');
    const text = `${loggedIn.length}/${all.length} 已登录` + (loggedIn.length > 0 ? `（${names}）` : '');
    const dot = loggedIn.length > 0 ? ' is-on' : known.length === all.length ? ' is-off' : '';
    return { dot, text };
  }, [platformLogins]);

  const { sent, skipped, awaiting } = useMemo(() => {
    let sent = 0;
    let skipped = 0;
    let awaiting = 0;
    for (const p of pending) {
      if (p.status === 'sent') sent += 1;
      else if (p.status === 'skipped') skipped += 1;
      else if (p.status === 'pending' || p.status === 'approved_queue' || p.status === 'approved') awaiting += 1;
    }
    return { sent, skipped, awaiting };
  }, [pending]);

  return (
    <footer className="statusbar">
      <div className="left">
        <span className={'status-dot' + (bridge === 'connected' ? ' is-on' : '')} />
        OpenClaw{bridge === 'connected' ? '已连接' : '未连接'}
        <span className="sep">·</span>
        <span className={'status-dot' + loginInfo.dot} />
        {loginInfo.text}
      </div>
      <div className="right">
        <span>
          已投递 <span className="num" style={{ color: 'var(--brand)' }}>{sent}</span>
        </span>
        <span className="sep">·</span>
        <span>
          已跳过 <span className="num">{skipped}</span>
        </span>
        <span className="sep">·</span>
        <span>
          待确认 <span className="num danger">{awaiting}</span>
        </span>
      </div>
    </footer>
  );
});