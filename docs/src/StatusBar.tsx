import { memo, useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useDataStore } from '../store/useDataStore';

export default memo(function StatusBar() {
  const bridge = useAppStore((s) => s.bridgeStatus);
  const bossLoggedIn = useAppStore((s) => s.bossLoggedIn);
  const pending = useDataStore((s) => s.pending);

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

  const electronVersion = window.electron?.versions?.electron || '31';

  return (
    <footer className="statusbar">
      <div className="left">
        <span className={'status-dot' + (bridge === 'connected' ? ' is-on' : '')} />
        OpenClaw{bridge === 'connected' ? '已连接' : '未连接'} · Electron {electronVersion}
        <span className="sep">·</span>
        <span className={'status-dot' + (bossLoggedIn === true ? ' is-on' : bossLoggedIn === false ? ' is-off' : '')} />
        BOSS {bossLoggedIn === true ? '已登录' : bossLoggedIn === false ? '未登录' : '检测中'}
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
          确认队列 <span className="num danger">{awaiting}</span>
        </span>
      </div>
    </footer>
  );
});