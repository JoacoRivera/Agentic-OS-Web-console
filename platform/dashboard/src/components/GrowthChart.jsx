import { fmtDay } from '../format.js';

const W = 1000;
const TOP = 14;
const PH = 196;
const BASE = TOP + PH;
const AXIS_IDX = [0, 7, 14, 21, 29];

/**
 * "Repository file growth" — cumulative file count by pathAddedDate (when
 * Git first saw the path). Deliberately NOT "knowledge accumulation": a
 * raw→wiki promotion adds a new path on the promotion date even though the
 * knowledge is older (ADR-0003). `all` double-counts promoted items.
 */
export default function GrowthChart({ metrics }) {
  const { series, all, last30 } = metrics;
  const days = series.length;
  const maxV = Math.max(...series.map((s) => s.v), 1);
  const X = (i) => (i / (days - 1)) * W;
  const Y = (v) => TOP + (1 - v / maxV) * PH;
  const pts = series.map((s, i) => `${X(i).toFixed(1)},${Y(s.v).toFixed(1)}`);
  const area = `M0,${BASE} L${pts.join(' L')} L${W},${BASE} Z`;
  const lx = X(days - 1);
  const ly = Y(series[days - 1].v);

  return (
    <div className="panel">
      <div className="label">
        Repository file growth · 30d
        <span className="label-sub">
          {all} files across tiers (double-counts promoted) · {last30} added last 30d
        </span>
      </div>
      <svg className="growth" viewBox={`0 0 ${W} ${BASE + 6}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="growthFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.30" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[1, 2, 3].map((g) => (
          <line key={`h${g}`} x1="0" y1={TOP + (PH / 4) * g} x2={W} y2={TOP + (PH / 4) * g} stroke="var(--line)" strokeWidth="1" />
        ))}
        {[1, 2, 3, 4].map((g) => (
          <line key={`v${g}`} x1={(W / 5) * g} y1={TOP} x2={(W / 5) * g} y2={BASE} stroke="var(--line)" strokeWidth="1" opacity="0.6" />
        ))}
        <path d={area} fill="url(#growthFill)" />
        <polyline points={pts.join(' ')} fill="none" stroke="var(--accent-2)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={lx} cy={ly} r="5" fill="var(--text)" />
        <circle cx={lx} cy={ly} r="9" fill="none" stroke="var(--accent-2)" strokeWidth="1.5" opacity="0.6" />
      </svg>
      <div className="axis">
        {AXIS_IDX.map((i) => (
          <span key={i}>{fmtDay(series[i].d)}</span>
        ))}
      </div>
    </div>
  );
}
