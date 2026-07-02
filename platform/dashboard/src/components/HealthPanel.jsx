import { fmtDay, fmtDayPlus } from '../format.js';

/**
 * Memory-health cadence: days since the last `lint` reconcilement pass
 * recorded in wiki/log.md (a /wiki-lint + /promote-draft-memory pass).
 */
export default function HealthPanel({ metrics }) {
  const { lastLint, healthStale, ageLabel, staleDays } = metrics.health;
  return (
    <div className="panel">
      <div className="label">
        Memory health · cadence
        <span className={`chip ${healthStale ? 'warn' : 'ok'}`}>
          <span className="status-dot" />
          {healthStale ? 'due' : 'ok'}
        </span>
      </div>
      <div className="run">
        <span className={`badge ${healthStale ? 'warn' : 'ok'}`}>{healthStale ? 'DUE' : 'OK'}</span>
        <span className="run-name">
          Last reconcile <span className="dim">· {ageLabel}</span>
        </span>
        <span className="run-time">{lastLint ? fmtDay(lastLint) : '—'}</span>
      </div>
      <div className="panel-note">
        {healthStale
          ? <>{staleDays}+ days since the last pass — run <b>/wiki-lint</b> + <b>/promote-draft-memory</b>, then commit.</>
          : <>Reconciled within {staleDays}d · next pass due {fmtDayPlus(lastLint, staleDays)}.</>}
      </div>
    </div>
  );
}
