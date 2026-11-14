import { Fragment, useState } from 'react';
import { ExternalLink } from 'lucide-react';

/**
 * Evals view (ADR-0001): the verdicts the owner recorded in the memory repo,
 * per eval and over time. Read-only — no score, health or regression of the
 * console's own; the console never runs or judges an eval. Record bodies stay
 * in the file: each row links to its results file and case page.
 */

const MARK = { PASS: 'P', PARTIAL: '~', FAIL: 'F' };

function describeRun(run) {
  const parts = [run.date, run.verdict];
  if (run.subject) parts.push(`subject: ${run.subject}`);
  if (run.note) parts.push(`note: ${run.note}`);
  return parts.join(' · ');
}

function Verdict({ verdict }) {
  return <span className={`eval-verdict v-${verdict.toLowerCase()}`}>{verdict}</span>;
}

function HistoryStrip({ id, runs }) {
  if (runs.length === 0) return <span className="eval-never">never run</span>;
  const oldestFirst = [...runs].reverse();
  return (
    <ol className="eval-strip" aria-label={`${id} recorded verdicts, oldest to newest`}>
      {oldestFirst.map((run) => (
        <li
          key={`${run.path}:${run.line}`}
          className={`eval-mark v-${run.verdict.toLowerCase()}`}
          title={describeRun(run)}
          aria-label={describeRun(run)}
        >
          {MARK[run.verdict]}
        </li>
      ))}
    </ol>
  );
}

function DocLink({ path, onOpenDoc }) {
  return (
    <button className="doc-link" onClick={() => onOpenDoc(path)} title="Open in Documentation">
      {path}
      <ExternalLink size={10} style={{ verticalAlign: '-1px', marginLeft: 5 }} />
    </button>
  );
}

function SuitePanel({ suite, problems, problemCount, root }) {
  return (
    <div className="panel">
      <div className="label">Eval suite</div>
      <div className="wf-summary">
        {suite.cases} cases · {suite.resultFiles} result files · {suite.runs} recorded runs · last run{' '}
        {suite.lastRunDate ?? '—'} · scanned live from {root}/
      </div>
      <div className="eval-clock">
        {suite.neverFullSuite ? (
          <span>No full-suite run recorded</span>
        ) : (
          <span>
            Last full-suite run {suite.lastFullSuiteDate} ({suite.ageDays} days ago)
          </span>
        )}
        {' · '}
        <span className={suite.due ? 'eval-due' : 'dim'}>
          {suite.due ? 'due' : 'not due'} — due at {suite.dueDays} days (memory-repo lint check 23)
        </span>
      </div>
      <div className="eval-lists">
        <div>
          <span className="dim">Cases never run: </span>
          {suite.neverRun.length ? suite.neverRun.join(', ') : 'none'}
        </div>
        <div>
          <span className="dim">Runs recorded but no case page: </span>
          {suite.withoutCase.length ? suite.withoutCase.join(', ') : 'none'}
        </div>
        <div>
          <span className="dim">Format problems: </span>
          {problemCount}
        </div>
      </div>
      {problems.length > 0 && (
        <ul className="eval-problems" aria-label="format problems">
          {problems.map((p) => (
            <li key={`${p.path}:${p.line}:${p.reason}`}>
              {p.path}
              {p.line ? `:${p.line}` : ''} — {p.reason}
            </li>
          ))}
          {problemCount > problems.length && <li className="dim">… {problemCount - problems.length} more</li>}
        </ul>
      )}
    </div>
  );
}

function RunList({ entry, onOpenDoc }) {
  return (
    <div className="eval-runs">
      {entry.case && (
        <div className="eval-case">
          <span className="dim">case page: </span>
          <DocLink path={entry.case.path} onOpenDoc={onOpenDoc} />
        </div>
      )}
      {entry.runs.length === 0 ? (
        <div className="eval-never">never run</div>
      ) : (
        <ul aria-label={`${entry.id} recorded runs, latest record first`}>
          {entry.runs.map((run) => (
            <li key={`${run.path}:${run.line}`}>
              <span className="eval-run-date">{run.date}</span> <Verdict verdict={run.verdict} />
              {run.subject && <span className="dim"> · subject: {run.subject}</span>}
              {run.note && <span className="dim"> · {run.note}</span>}
              {run.type && <span className="dim"> · {run.type}</span>}
              {run.confirmed && <span className="chip ok">confirmed by owner</span>}
              {run.missingFields.length > 0 && (
                <span className="eval-missing"> · missing fields: {run.missingFields.join(', ')}</span>
              )}{' '}
              <DocLink path={run.path} onOpenDoc={onOpenDoc} />
              <span className="dim">:{run.line}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function EvalHistory({ data, onOpenDoc }) {
  const [open, setOpen] = useState(null);
  const { evals, suite, problems, problemCount, orderNote, root } = data;

  return (
    <>
      <div className="notice">
        Verdicts are recorded by the owner in the memory repo. The console never runs or judges an
        eval (ADR-0001).
      </div>
      <SuitePanel suite={suite} problems={problems} problemCount={problemCount} root={root} />
      <div className="panel">
        <div className="label">Recorded verdicts</div>
        <div className="wf-summary">{orderNote}</div>
        {evals.length === 0 ? (
          <div className="placeholder-body">No eval cases or results under {root}/.</div>
        ) : (
          <table className="wf-table eval-table">
            <thead>
              <tr>
                <th>Eval</th>
                <th>Case type</th>
                <th>Last run</th>
                <th>Latest record</th>
                <th>PASS · PARTIAL · FAIL</th>
                <th>History (oldest → newest)</th>
              </tr>
            </thead>
            <tbody>
              {evals.map((entry) => {
                const expanded = open === entry.id;
                return (
                  <Fragment key={entry.id}>
                    <tr className={expanded ? 'selected' : undefined}>
                      <td>
                        <button
                          className="eval-toggle"
                          aria-expanded={expanded}
                          onClick={() => setOpen(expanded ? null : entry.id)}
                        >
                          {entry.id}
                        </button>
                      </td>
                      <td className="wf-kind">{entry.case ? (entry.case.type ?? '—') : 'no case page'}</td>
                      <td>{entry.lastRunDate ?? <span className="eval-never">never run</span>}</td>
                      <td>{entry.latest ? <Verdict verdict={entry.latest.verdict} /> : '—'}</td>
                      <td className="eval-counts">
                        {entry.counts.PASS} · {entry.counts.PARTIAL} · {entry.counts.FAIL}
                      </td>
                      <td>
                        <HistoryStrip id={entry.id} runs={entry.runs} />
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="eval-detail-row">
                        <td colSpan={6}>
                          <RunList entry={entry} onOpenDoc={onOpenDoc} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
