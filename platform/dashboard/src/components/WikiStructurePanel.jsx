import { useCallback, useEffect, useState } from 'react';
import ExecutableOperationCard from './ExecutableOperationCard.jsx';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function chipsFor(lastRun) {
  if (!lastRun) return [{ cls: 'chip', text: 'never run' }];
  const result = lastRun.result;
  if (!result || !result.parsed) return [{ cls: 'chip warn', text: 'failed' }];
  if (result.errors === 0 && result.warnings === 0) return [{ cls: 'chip ok', text: 'clean' }];
  const chips = [];
  if (result.errors > 0) chips.push({ cls: 'chip warn', text: plural(result.errors, 'error') });
  if (result.warnings > 0) chips.push({ cls: 'chip warn', text: plural(result.warnings, 'warning') });
  return chips;
}

function RunSummary({ lastRun }) {
  if (!lastRun) {
    return <div className="placeholder-body">No run on record. Run the check, then confirm, to lint the wiki.</div>;
  }
  const { result } = lastRun;
  const seconds = typeof lastRun.durationMs === 'number' ? ` · ${(lastRun.durationMs / 1000).toFixed(1)}s` : '';
  const exit = lastRun.exitCode === null || lastRun.exitCode === undefined ? '' : ` · exit ${lastRun.exitCode}`;
  return (
    <>
      <div className="exec-result-meta">
        ran {lastRun.ts}
        {exit}
        {seconds} — a snapshot of that run, not live
      </div>
      {!result || !result.parsed ? (
        <div className="panel-note">
          <b>Result unavailable</b> — {result?.reason ?? 'this run has no parsed result'}. The full
          output is in the Audit Log.
        </div>
      ) : (
        <>
          {result.findings.length > 0 && (
            <table className="kv">
              <tbody>
                {result.findings.map((f, i) => (
                  <tr key={i}>
                    <td className={f.level === 'error' ? 'warn-text' : ''}>{f.level}</td>
                    <td>{f.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {result.truncated && (
            <div className="panel-note">
              Showing {result.findings.length} of {result.findingsTotal} findings (long messages are
              cut); the Audit Log keeps the output tail.
            </div>
          )}
          {result.incomplete && (
            <div className="panel-note">
              The listed findings do not match the report&apos;s counts — the counts above are the
              lint&apos;s own; see the Audit Log for the full output.
            </div>
          )}
        </>
      )}
    </>
  );
}

/**
 * Maintenance: the last `check:wiki-structure` run (ADR-0001 amendment,
 * 2026-11-14) — the deterministic half of maintenance-pass step 1 — plus the
 * executable card to run it again. What it shows is a snapshot of that run;
 * it never runs on load, feeds no metric and never resets the cadence.
 */
export default function WikiStructurePanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async (isCancelled = () => false) => {
    try {
      const res = await fetch('/api/maintenance/wiki-structure');
      const body = await res.json().catch(() => ({}));
      if (isCancelled()) return;
      if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
      setData(body);
      setError(null);
    } catch (err) {
      if (!isCancelled()) setError(err.message);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  const onFinished = useCallback(() => {
    load();
  }, [load]);

  return (
    <div className="panel">
      <div className="skill-head">
        <span className="label">Wiki structure</span>
        {data && chipsFor(data.lastRun).map((c) => (
          <span key={c.text} className={c.cls}>
            {c.text}
          </span>
        ))}
      </div>
      {!data ? (
        <div className="placeholder-body">
          {error ? `Wiki structure check unavailable — ${error}` : 'Loading last wiki structure check…'}
        </div>
      ) : (
        <>
          <RunSummary lastRun={data.lastRun} />
          <div className="panel-note">
            Deterministic half of maintenance-pass step 1. The judgment checks are{' '}
            <code>/aos-wiki-lint</code> in Claude; only the <code>lint | maintenance pass</code> log
            entry resets the cadence.
          </div>
          {data.operation && <ExecutableOperationCard op={data.operation} onFinished={onFinished} />}
        </>
      )}
    </div>
  );
}
