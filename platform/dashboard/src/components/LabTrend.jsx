import { useLayoutEffect, useRef, useState } from 'react';

const H = 160;
const TOP = 16;
const BOTTOM = 12;
const PH = H - TOP - BOTTOM;
const GUTTER = 14;
const FALLBACK_W = 800;

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
 * One lab marker across a member's exam notes (ADR-0010 §6). Points are
 * spaced by sample index, not by calendar time, so sparse years do not
 * compress the recent draws. There is deliberately no threshold band: each
 * point's reference range is the one printed by *its* lab on *its* note, and
 * the table under the plot shows exactly that.
 */
export default function LabTrend({ trend, onOpenNote }) {
  const box = useRef(null);
  const width = usePlotWidth(box);
  if (!trend) return <div className="placeholder-body">Choose a marker to plot.</div>;
  const { points, marker, excludedN } = trend;
  if (points.length === 0) {
    return <div className="placeholder-body">No numeric results for “{marker}”.</div>;
  }
  const values = points.map((p) => p.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || Math.abs(hi) || 1;
  const yMin = lo - span * 0.15;
  const yMax = hi + span * 0.15;
  const PW = width - GUTTER * 2;
  const X = (i) => GUTTER + (points.length === 1 ? PW / 2 : (i / (points.length - 1)) * PW);
  const Y = (v) => TOP + (1 - (v - yMin) / (yMax - yMin)) * PH;
  const pts = points.map((p, i) => `${X(i).toFixed(1)},${Y(p.value).toFixed(1)}`);
  const unit = points.find((p) => p.unit)?.unit ?? '';

  return (
    <div>
      <div className="label-sub fh-trend-caption">
        {marker} · {points.length} draw{points.length === 1 ? '' : 's'}
        {unit ? ` · ${unit}` : ''}
        {excludedN > 0 ? ` · ${excludedN} non-numeric result${excludedN === 1 ? '' : 's'} excluded` : ''}
      </div>
      <div className="growth-plot" ref={box}>
        <svg
          className="growth"
          viewBox={`0 0 ${width} ${H}`}
          overflow="visible"
          role="img"
          aria-label={`${marker}: ${points.length} numeric results, each with its own lab reference range`}
        >
          {[1, 2, 3].map((g) => (
            <line key={g} x1={GUTTER} y1={TOP + (PH / 4) * g} x2={GUTTER + PW} y2={TOP + (PH / 4) * g} stroke="var(--line)" strokeWidth="1" />
          ))}
          {points.length > 1 && (
            <polyline points={pts.join(' ')} fill="none" stroke="var(--accent-2)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          )}
          {points.map((p, i) => (
            <g key={`${p.date}-${i}`}>
              <circle cx={X(i)} cy={Y(p.value)} r="4.5" fill={p.flag && !/^ok/i.test(p.flag) ? 'var(--accent)' : 'var(--text)'} />
              <title>{`${p.date ?? '—'} · ${p.result} ${p.unit} · range ${p.range || '—'} · ${p.flag || 'no flag'}${p.facility ? ` · ${p.facility}` : ''}`}</title>
            </g>
          ))}
        </svg>
        <div className="axis">
          {points.map((p, i) => (
            <span
              key={`${p.date}-${i}`}
              style={{
                left: `${X(i).toFixed(1)}px`,
                transform: i === 0 && points.length > 1 ? 'none' : i === points.length - 1 && points.length > 1 ? 'translateX(-100%)' : 'translateX(-50%)',
              }}
            >
              {p.date ?? '—'}
            </span>
          ))}
        </div>
      </div>
      <table className="kv fh-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Result</th>
            <th>Range (as printed)</th>
            <th>Flag</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p, i) => (
            <tr key={`${p.date}-${i}`}>
              <td>{p.date ?? '—'}</td>
              <td>{p.result} {p.unit}</td>
              <td>{p.range || '—'}</td>
              <td className={p.flag && !/^ok/i.test(p.flag) ? 'warn-text' : ''}>{p.flag || '—'}</td>
              <td>
                <button className="link-btn" onClick={() => onOpenNote(p.path)} title={p.path}>
                  open
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
