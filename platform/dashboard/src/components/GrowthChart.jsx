import { fmtDay } from '../format.js';

const W = 1000;
const TOP = 14;
const PH = 196;
const BASE = TOP + PH;
const AXIS_IDX = [0, 7, 14, 21, 29];

/**
 * Cumulative distinct intake sources by explicit lineage metadata. A
 * raw→wiki promotion resolves to the raw origin and adds no new event.
 * Coverage is shown because unlineaged/invalid files are excluded rather
 * than assigned a guessed date.
 */
export default function GrowthChart({ metrics }) {
  const { series, knowledgeN, lineage, last30 } = metrics;
  const incompleteN = lineage.unlineagedN + lineage.invalidN;
  const knowledgeLabel = incompleteN > 0 ? 'known distinct sources' : 'distinct sources';
  const lineageState = incompleteN > 0
    ? `Lineage incomplete · ${incompleteN} file${incompleteN === 1 ? '' : 's'} excluded`
    : 'Lineage complete · all eligible files included';
  const days = series.length;
  const maxV = Math.max(...series.map((s) => s.v), 1);
  const X = (i) => (i / (days - 1)) * W;
  const Y = (v) => TOP + (1 - v / maxV) * PH;
  const pts = series.map((s, i) => `${X(i).toFixed(1)},${Y(s.v).toFixed(1)}`);
  const area = `M0,${BASE} L${pts.join(' L')} L${W},${BASE} Z`;
  const lx = X(days - 1);
  const ly = Y(series[days - 1].v);
  const firstV = series[0].v;
  const latestV = series[days - 1].v;
  const trend = latestV > firstV ? 'rising' : latestV < firstV ? 'falling' : 'unchanged';

  return (
    <div className="panel">
      <div className="label">
        Knowledge intake · 30d
        <span className="label-sub">
          {knowledgeN} {knowledgeLabel} · {last30} entered last 30d ·{' '}
          {lineage.lineagedN}/{lineage.eligibleN} files lineaged · {lineageState}
        </span>
      </div>
      <svg
        className="growth"
        viewBox={`0 0 ${W} ${BASE + 6}`}
        preserveAspectRatio="none"
        overflow="visible"
        role="img"
        aria-label={`Knowledge intake series, 30 days, ${trend} from ${firstV} to ${latestV} ${knowledgeLabel}`}
      >
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
