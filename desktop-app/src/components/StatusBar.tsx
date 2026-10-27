import { memo, useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useDataStore } from '../store/useDataStore';
import { usePersistFailures } from '../lib/hooks';
import { measureStorageUsage, formatStorageSize, LOCAL_STORAGE_QUOTA_UNITS } from '../lib/storage';
import { PLATFORM_IDS, PLATFORM_META } from '../lib/bossclaw/platforms';

/** 本地存储占用预警阈值：写满（100%）后所有写入都会被静默丢弃，80% 起提前提示 */
const STORAGE_WARN_RATIO = 0.8;
/** 用量采样间隔：getItem 会复制一次全部键（数 MB），不需要更密 */
const STORAGE_SAMPLE_MS = 300_000;

export default memo(function StatusBar() {
  const bridge = useAppStore((s) => s.bridgeStatus);
  const platformLogins = useAppStore((s) => s.platformLogins);
  const openSettings = useAppStore((s) => s.openSettings);
  const pending = useDataStore((s) => s.pending);
  // issue #10：本地存储写失败（配额写满等）时必须让用户看到——否则引擎照常跑、界面数据照常推进，
  // 只有重启后才发现整段进度没落盘。点击直达「设置 → 数据与备份」看占用并清理。
  const persistFailures = usePersistFailures();
  // 写满之前就预警：到 80% 提示一次，别等「已经丢了一整天的数据」才发现
  const [usageRatio, setUsageRatio] = useState(0);
  useEffect(() => {
    const sample = () => {
      try { setUsageRatio(measureStorageUsage().ratio); } catch { /* 存储不可用则不提示 */ }
    };
    sample();
    const t = window.setInterval(sample, STORAGE_SAMPLE_MS);
    return () => window.clearInterval(t);
  }, []);
  const storagePercent = Math.round(usageRatio * 100);
  const warnTip = useMemo(() => {
    if (persistFailures.length === 0) return '';
    const keys = persistFailures.map((f) => f.name).join('、');
    const first = persistFailures[0];
    return `本地存储写入失败（${keys}）：${first.message}\n最新进度已转存到本地备份文件，但重启后仍可能回退。请点开清理队列记录或导出备份。`;
  }, [persistFailures]);

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
        {persistFailures.length > 0 ? (
          <>
            <span className="sep">·</span>
            <button
              type="button"
              className="status-warn"
              title={warnTip}
              onClick={() => openSettings('data')}
            >
              <i />
              本地数据未保存
            </button>
          </>
        ) : usageRatio >= STORAGE_WARN_RATIO ? (
          <>
            <span className="sep">·</span>
            <button
              type="button"
              className="status-warn is-warning"
              title={`本地存储已用 ${storagePercent}%（同源上限 ${formatStorageSize(LOCAL_STORAGE_QUOTA_UNITS)}）。写满后所有数据都无法落盘，重启会回退到旧数据。请点开清理岗位队列。`}
              onClick={() => openSettings('data')}
            >
              本地存储 {storagePercent}%
            </button>
          </>
        ) : null}
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