import { useMemo, useState } from 'react';

/**
 * Audit log (Phase 3 + roadmap §4.3): a tail of platform/logs/operations.log
 * (spanning rotated files) — one JSON entry per executed operation (op, ts,
 * status, files, output), filterable by operation and status. Non-JSON lines
 * are shown verbatim rather than dropped; an empty trail simply means
 * nothing has been run yet.
 */
export default function AuditLog({ data }) {
  const { entries, total, path } = data;
  const [opFilter, setOpFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const ops = useMemo(
    () => [...new Set(entries.filter((e) => e.op).map((e) => e.op))].sort(),
    [entries]
  );
  const statuses = useMemo(
    () => [...new Set(entries.filter((e) => e.status).map((e) => e.status))].sort(),
    [entries]
  );

  const shown = entries.filter(
    (e) =>
      (!opFilter || e.op === opFilter) && (!statusFilter || e.status === statusFilter)
  );

  return (
    <div className="panel">
      <div className="label">
        Audit log <span className="label-sub">{total} entries</span>
      </div>
      <div className="wf-summary">tail of {path}</div>
      {entries.length === 0 ? (
        <div className="placeholder-body">
          No audit entries yet. Each confirmed run of an allowlisted executable operation
          appends one entry here (op, timestamp, status, files, output) — nothing else can
          execute (ADR-0001).
        </div>
      ) : (
        <>
          <div className="audit-filters">
            <select
              className="op-param-input"
              value={opFilter}
              onChange={(e) => setOpFilter(e.target.value)}
            >
              <option value="">all operations</option>
              {ops.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
            <select
              className="op-param-input"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">all statuses</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <span className="audit-meta">
              {shown.length}/{entries.length} shown
            </span>
          </div>
          <div className="audit-list">
            {[...shown].reverse().map((entry, i) =>
              entry.op ? (
                <div className="audit-entry" key={i}>
                  <div className="audit-entry-head">
                    <span className={`chip ${entry.status === 'ok' ? 'ok' : 'warn'}`}>
                      {entry.status}
                    </span>
                    <span className="audit-op">{entry.op}</span>
                    <span className="audit-meta">
                      {entry.ts} · exit {entry.exitCode ?? '—'}
                      {typeof entry.durationMs === 'number' &&
                        ` · ${(entry.durationMs / 1000).toFixed(1)}s`}
                      {Array.isArray(entry.files) && ` · ${entry.files.length} file(s) changed`}
                    </span>
                  </div>
                  {entry.files?.length > 0 && (
                    <pre className="exec-stream">{entry.files.join('\n')}</pre>
                  )}
                </div>
              ) : (
                <div className="audit-entry" key={i}>
                  {entry.raw ?? JSON.stringify(entry)}
                </div>
              )
            )}
          </div>
        </>
      )}
    </div>
  );
}
