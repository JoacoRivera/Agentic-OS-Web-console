import { useLayoutEffect, useRef, useState } from 'react';
import { fmtDay } from '../format.js';

const H = 180;
const TOP = 14;
const BOTTOM = 10;
const PH = H - TOP - BOTTOM;
const BASE = TOP + PH;
const GUTTER = 12;
const FALLBACK_W = 1000;
const AXIS_TICKS = 5;

/**
 * The chart is drawn in CSS pixels, not in a stretched viewBox: with
 * `preserveAspectRatio="none"` the endpoint marker renders as an ellipse and
 * grid strokes thicken on one axis only. Measuring the panel keeps the user
 * space 1:1, so a circle stays a circle at any width.
 */
function usePlotWidth(ref) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width > 0 ? width : FALLBACK_W;
}

/**
 * Cumulative distinct intake sources by explicit lineage metadata. A
 * raw→wiki promotion resolves to the raw origin and adds no new event.
 * Coverage is shown because unlineaged/invalid files are excluded rather
 * than assigned a guessed date.
 */
export default function GrowthChart({ metrics }) {
  const { series, knowledgeN, lineage, last30 } = metrics;
  const box = useRef(null);
  const width = usePlotWidth(box);
  const incompleteN = lineage.unlineagedN + lineage.invalidN;
  const knowledgeLabel = incompleteN > 0 ? 'known distinct sources' : 'distinct sources';
  const lineageState = incompleteN > 0
    ? `Lineage incomplete · ${incompleteN} file${incompleteN === 1 ? '' : 's'} excluded`
    : 'Lineage complete · all eligible files included';
  const days = series.length;
  const maxV = Math.max(...series.map((s) => s.v), 1);
  // The right gutter keeps the endpoint marker inside the plot instead of
  // hanging over the panel border.
  const PW = width - GUTTER;
  const X = (i) => (i / (days - 1)) * PW;
  const Y = (v) => TOP + (1 - v / maxV) * PH;
  const pts = series.map((s, i) => `${X(i).toFixed(1)},${Y(s.v).toFixed(1)}`);
  const area = `M0,${BASE} L${pts.join(' L')} L${X(days - 1).toFixed(1)},${BASE} Z`;
  const lx = X(days - 1);
  const ly = Y(series[days - 1].v);
  const firstV = series[0].v;
  const latestV = series[days - 1].v;
  const trend = latestV > firstV ? 'rising' : latestV < firstV ? 'falling' : 'unchanged';
  // Ticks label real sample positions, so the grid is drawn at the same
  // indices — evenly spaced rules would not line up with the dates.
  const ticks = [...new Set(
    Array.from({ length: AXIS_TICKS }, (_, n) => Math.floor((n / (AXIS_TICKS - 1)) * (days - 1)))
  )];

  return (
    <div className="panel">
      <div className="label">
        Knowledge intake · 30d
        <span className="label-sub">
          {knowledgeN} {knowledgeLabel} · {last30} entered last 30d ·{' '}
          {lineage.lineagedN}/{lineage.eligibleN} files lineaged · {lineageState}
        </span>
      </div>
      <div className="growth-plot" ref={box}>
        <svg
          className="growth"
          viewBox={`0 0 ${width} ${H}`}
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
            <line key={`h${g}`} x1="0" y1={TOP + (PH / 4) * g} x2={PW} y2={TOP + (PH / 4) * g} stroke="var(--line)" strokeWidth="1" />
          ))}
          {ticks.slice(1, -1).map((i) => (
            <line key={`v${i}`} x1={X(i).toFixed(1)} y1={TOP} x2={X(i).toFixed(1)} y2={BASE} stroke="var(--line)" strokeWidth="1" opacity="0.6" />
          ))}
          <path d={area} fill="url(#growthFill)" />
          <polyline points={pts.join(' ')} fill="none" stroke="var(--accent-2)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={lx} cy={ly} r="4.5" fill="var(--text)" />
          <circle cx={lx} cy={ly} r="8" fill="none" stroke="var(--accent-2)" strokeWidth="1.5" opacity="0.6" />
        </svg>
        <div className="axis">
          {ticks.map((i, n) => (
            <span
              key={i}
              style={{
                left: `${X(i).toFixed(1)}px`,
                transform: n === 0 ? 'none' : n === ticks.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
              }}
            >
              {fmtDay(series[i].d)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
