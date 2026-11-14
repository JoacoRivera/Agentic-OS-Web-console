import { fmtDay } from '../format.js';

/**
 * Memory-flow stats (`/api/metrics.flow`, mirroring the memory repo's
 * scripts/memory-stats.py — ADR-0003 amendment 2026-11-14): capture → ingest
 * latency, maintenance-pass gaps, Ingest queue age and monthly counts. Dates
 * are explicit lineage only; a figure with no data shows its reason, never 0.
 */

const days = (v) => `${Number.isInteger(v) ? v : v.toFixed(1)}d`;

function Row({ name, note, value }) {
  return (
    <div className="run">
      <span className="run-name">
        {name}
        {note && <span className="dim"> · {note}</span>}
      </span>
      <span className="run-time">{value}</span>
    </div>
  );
}

function Latency({ latency }) {
  return (
    <div className="panel">
      <div className="label">Capture → ingest latency</div>
      {latency.n === 0 ? (
        <Row name="No dated ingest entries yet" />
      ) : (
        <>
          <Row
            name="Median · p90 · max"
            note={`${latency.n} captures`}
            value={`${days(latency.median)} · ${days(latency.p90)} · ${days(latency.max)}`}
          />
          {latency.buckets.map((b) => (
            <Row key={b.label} name={b.label} value={b.count} />
          ))}
        </>
      )}
      {(latency.noDatedIngestEntry > 0 || latency.ingestBeforeIntake > 0) && (
        <div className="panel-note">
          {latency.noDatedIngestEntry > 0 && (
            <div>
              {latency.noDatedIngestEntry} Ingested with no dated ingest log entry — no latency.
            </div>
          )}
          {latency.ingestBeforeIntake > 0 && (
            <div>
              {latency.ingestBeforeIntake} with an ingest entry dated before the knowledge intake
              date — excluded.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Passes({ passes }) {
  const over = passes.gapsOverCadence > 0;
  return (
    <div className="panel">
      <div className="label">
        Maintenance-pass gaps
        {passes.days > 1 && (
          <span className={`chip ${over ? 'warn' : 'ok'}`}>
            <span className="status-dot" />
            {over ? `${passes.gapsOverCadence} over ${passes.cadenceDays}d` : `within ${passes.cadenceDays}d`}
          </span>
        )}
      </div>
      {passes.days === 0 ? (
        <Row name="No maintenance pass on record" />
      ) : (
        <>
          <Row name="Pass days" value={passes.days} />
          {passes.longestGap ? (
            <>
              <Row
                name="Longest gap"
                note={`${fmtDay(passes.longestGap.from)} → ${fmtDay(passes.longestGap.to)}`}
                value={days(passes.longestGap.days)}
              />
              <Row name="Median gap" value={days(passes.gaps.median)} />
              <Row name={`Gaps over the ${passes.cadenceDays}-day cadence`} value={passes.gapsOverCadence} />
            </>
          ) : (
            <Row name="One pass on record — no gap yet" />
          )}
          <Row name="Open gap" note={`since ${fmtDay(passes.newest)}`} value={days(passes.openGapDays)} />
        </>
      )}
    </div>
  );
}

function QueueRow({ name, q }) {
  let value;
  if (q.count === 0) value = 'empty';
  else if (q.ages.n === 0) value = 'no intake date — age unknown';
  else value = `oldest ${days(q.ages.max)} · median ${days(q.ages.median)}`;
  const notes = [];
  if (q.count > 0) notes.push(`${q.count}`);
  if (q.unlineaged > 0 && q.ages.n > 0) notes.push(`${q.unlineaged} without intake date`);
  return <Row name={name} note={notes.join(' · ') || undefined} value={value} />;
}

function Queue({ queue }) {
  return (
    <div className="panel">
      <div className="label">Ingest queue age</div>
      <QueueRow name="Draft" q={queue.draft} />
      <QueueRow name="On hold" q={queue.onHold} />
      <div className="panel-note">Aged from the knowledge intake date to today.</div>
    </div>
  );
}

function Months({ months, unlineaged }) {
  return (
    <div className="panel">
      <div className="label">By month</div>
      {months.length === 0 ? (
        <Row name="No dated captures or ingest entries" />
      ) : (
        <table className="flow-table">
          <thead>
            <tr>
              <th>Month</th>
              <th>Captures · by intake date</th>
              <th>Ingest log entries</th>
            </tr>
          </thead>
          <tbody>
            {[...months].reverse().map((m) => (
              <tr key={m.month}>
                <td>{m.month}</td>
                <td>{m.captures}</td>
                <td>{m.ingestEntries}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {unlineaged > 0 && (
        <div className="panel-note">
          {unlineaged} captures have no valid lineage and are left out of dated figures.
        </div>
      )}
    </div>
  );
}

export default function MemoryFlow({ metrics }) {
  const flow = metrics?.flow;
  if (!flow) return null;
  return (
    <>
      <div className="grid-2">
        <Latency latency={flow.latency} />
        <Passes passes={flow.passes} />
      </div>
      <div className="grid-2">
        <Queue queue={flow.queue} />
        <Months months={flow.months} unlineaged={flow.captures.unlineaged} />
      </div>
    </>
  );
}
