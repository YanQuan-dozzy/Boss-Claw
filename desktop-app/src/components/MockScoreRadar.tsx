// 报告页维度雷达图（纯 SVG，零依赖）
//
// 为什么不用图表库：项目没有 recharts / echarts 依赖，为一张五维图引入 100KB+ 的做法
// 与「本地优先、包体积敏感」的定位冲突。五维雷达图手写坐标即可，也更容易跟随主题变量。
//
// 参考 JadeAI 的雷达图：它把维度轮廓和上一场轮廓叠在一起，一眼看出哪一维退步了。
// 这里沿用同一思路，但把「N/A」画在圆心并在标签里写明——N/A 不是 0 分，不能视觉压分。
import type { CSSProperties } from 'react';

export interface RadarDim {
  /** 维度 key（可选）：有 key 时两侧轮廓按 key 对齐，不再依赖数组顺序 */
  key?: string;
  label: string;
  score: number | null;
}

interface Props {
  dims: RadarDim[];
  /** 上一场轮廓（可选，虚线） */
  prev?: RadarDim[] | null;
  size?: number;
  style?: CSSProperties;
}

function ratioOf(score: number | null): number {
  if (score == null || !Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, Number(score) / 100));
}

export default function MockScoreRadar({ dims, prev, size = 248, style }: Props) {
  const n = Math.max(3, dims.length);
  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - 34;
  const angleOf = (i: number) => -Math.PI / 2 + (2 * Math.PI * i) / n;
  const at = (i: number, ratio: number) => {
    const a = angleOf(i);
    return [cx + Math.cos(a) * R * ratio, cy + Math.sin(a) * R * ratio] as const;
  };
  const poly = (list: RadarDim[]) =>
    list
      .slice(0, n)
      .map((d, i) => at(i, ratioOf(d.score)).map((v) => v.toFixed(1)).join(','))
      .join(' ');

  const rings = [0.25, 0.5, 0.75, 1];
  const prevDims = prev && prev.length >= 3 ? prev : null;

  /**
   * 上一场在某一轴上的比例；**N/A 返回 null**（而不是 0）。
   * 审查 2026-10-21 B-6：原实现把 N/A 交给 ratioOf → 0，上一场某维无分会把虚线轮廓
   * 拽到圆心，视觉上等于「这一维上次是 0 分」，与下方「N/A 不代表 0 分」的口径自相矛盾。
   * 现在 N/A 的轴不参与虚线，改为断开（见下方分段绘制）。
   */
  const prevRatioAt = (i: number, dim: RadarDim | undefined): number | null => {
    if (!prevDims || !dim) return null;
    const hit = dim.key ? prevDims.find((x) => x.key === dim.key) : undefined;
    const p = hit || prevDims[i];
    return p && p.score != null ? ratioOf(p.score) : null;
  };

  return (
    <svg
      className="mi-radar"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="维度分雷达图"
      style={style}
    >
      {/* 刻度环：25 / 50 / 75 / 100 */}
      {rings.map((r) => (
        <polygon
          key={`ring-${r}`}
          className={r === 1 ? 'mi-radar-ring mi-radar-ring--outer' : 'mi-radar-ring'}
          points={Array.from({ length: n }, (_, i) => at(i, r).map((v) => v.toFixed(1)).join(',')).join(' ')}
        />
      ))}
      {/* 轴线 */}
      {Array.from({ length: n }, (_, i) => {
        const [x, y] = at(i, 1);
        return <line key={`axis-${i}`} className="mi-radar-axis" x1={cx} y1={cy} x2={x.toFixed(1)} y2={y.toFixed(1)} />;
      })}

      {/* 上一场轮廓：逐段绘制，任一端是 N/A 就断开（不把「没分」画成 0 分） */}
      {prevDims
        ? Array.from({ length: n }, (_, i) => {
          const next = (i + 1) % n;
          const a = prevRatioAt(i, dims[i]);
          const b = prevRatioAt(next, dims[next]);
          if (a == null || b == null) return null;
          const [x1, y1] = at(i, a);
          const [x2, y2] = at(next, b);
          return (
            <line
              key={`prev-${i}`}
              className="mi-radar-prev"
              x1={x1.toFixed(1)}
              y1={y1.toFixed(1)}
              x2={x2.toFixed(1)}
              y2={y2.toFixed(1)}
            />
          );
        })
        : null}
      {/* 上一场的顶点（有分的轴才画点，便于对齐看差值） */}
      {prevDims
        ? dims.slice(0, n).map((d, i) => {
          const r = prevRatioAt(i, d);
          if (r == null) return null;
          const [x, y] = at(i, r);
          return <circle key={`prev-dot-${i}`} className="mi-radar-prev-dot" cx={x.toFixed(1)} cy={y.toFixed(1)} r={2} />;
        })
        : null}

      {/* 本场轮廓 */}
      <polygon className="mi-radar-poly" points={poly(dims)} />
      {dims.slice(0, n).map((d, i) => {
        const [x, y] = at(i, ratioOf(d.score));
        return <circle key={`dot-${i}`} className="mi-radar-dot" cx={x.toFixed(1)} cy={y.toFixed(1)} r={2.6} />;
      })}

      {/* 标签：外侧对齐，N/A 用弱化色 */}
      {dims.slice(0, n).map((d, i) => {
        const a = angleOf(i);
        const lx = cx + Math.cos(a) * (R + 20);
        const ly = cy + Math.sin(a) * (R + 20);
        const cos = Math.cos(a);
        const anchor = Math.abs(cos) < 0.2 ? 'middle' : cos > 0 ? 'start' : 'end';
        const na = d.score == null;
        return (
          <g key={`label-${i}`}>
            <text className="mi-radar-label" x={lx.toFixed(1)} y={(ly - 2).toFixed(1)} textAnchor={anchor}>
              {d.label}
            </text>
            <text className={na ? 'mi-radar-value mi-radar-value--na' : 'mi-radar-value'} x={lx.toFixed(1)} y={(ly + 12).toFixed(1)} textAnchor={anchor}>
              {na ? 'N/A' : d.score}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
