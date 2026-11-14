import { fmtDay, fmtDayPlus } from '../format.js';

/**
 * Maintenance-pass cadence (memory repo AGENTS.md §Maintenance pass): days
 * since the newest `lint | maintenance pass` log entry, read across
 * wiki/log.md and its monthly archive. Only that subject resets the timer;
 * the pass is due at 7+ days (or when none exists) and overdue at 10+.
 *
 * Review-by dates (wiki-lint check 25) sit under it as information only:
 * a due date never changes the cadence chip.
 */
export default function HealthPanel({ metrics }) {
  const { lastPass, healthStale, overdue, ageLabel, staleDays, ingestedSincePass, reviewBy } = metrics.health;
  const state = overdue ? 'overdue' : healthStale ? 'due' : 'ok';
  return (
    <div className="panel">
      <div className="label">
        Maintenance pass · cadence
        <span className={`chip ${healthStale ? 'warn' : 'ok'}`}>
          <span className="status-dot" />
          {state}
        </span>
      </div>
      <div className="run">
        <span className={`badge ${healthStale ? 'warn' : 'ok'}`}>{state.toUpperCase()}</span>
        <span className="run-name">
          Last pass <span className="dim">· {ageLabel}</span>
        </span>
        <span className="run-time">{lastPass ? fmtDay(lastPass) : '—'}</span>
      </div>
      {ingestedSincePass !== null && ingestedSincePass !== undefined && (
        <div className="run">
          <span className="run-name">
            Ingested since the last pass <span className="dim">· to skim</span>
          </span>
          <span className="run-time">{ingestedSincePass}</span>
        </div>
      )}
      {reviewBy && (
        <>
          <div className="run" title="wiki-lint check 25 · information only, never changes the cadence">
            <span className="run-name">
              Review-by dates <span className="dim">· {reviewBy.dueN} due</span>
              {reviewBy.malformedN > 0 && <span className="dim"> · {reviewBy.malformedN} malformed</span>}
            </span>
            <span className="run-time">{reviewBy.nextDue ? `next due ${reviewBy.nextDue}` : '—'}</span>
          </div>
          {reviewBy.items.map((item, i) => (
            // The index disambiguates the same token repeated on one line.
            <div key={`${i}:${item.path}:${item.line}:${item.date}`} className="run review-by-item">
              <span className="run-time">{item.date}</span>
              <span className="run-name" title={`${item.path}:${item.line}`}>
                {item.path}:{item.line}
              </span>
              <span className="run-path">{item.state === 'due' ? 'due' : 'malformed (want YYYY-MM-DD)'}</span>
            </div>
          ))}
        </>
      )}
      <div className="panel-note">
        {healthStale
          ? <>{lastPass ? `${staleDays}+ days since the last pass` : 'No maintenance pass on record'} — run <b>/aos-wiki-lint</b>, skim what was ingested, make the judgment fixes, then log <code>lint | maintenance pass</code>.</>
          : <>Pass within {staleDays}d · next pass due {fmtDayPlus(lastPass, staleDays)}.</>}
      </div>
    </div>
  );
}
