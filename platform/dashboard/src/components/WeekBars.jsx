import { fmtWeekdayLetter } from '../format.js';

export default function WeekBars({ metrics }) {
  const { week, weekTotal } = metrics;
  const max = Math.max(...week.map((b) => b.c), 1);
  return (
    <div className="panel">
      <div className="label">
        Last 7 days
        <span className="label-sub">{weekTotal} changes</span>
      </div>
      <div className="week">
        {week.map((b) => (
          <div key={b.d} className="week-col">
            <div className="week-bar-track">
              <div className="week-bar" style={{ height: `${Math.round((b.c / max) * 100)}%` }} />
            </div>
            <div className="week-day">{fmtWeekdayLetter(b.d)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
