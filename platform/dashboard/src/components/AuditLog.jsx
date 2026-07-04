/**
 * Audit log (Phase 3 sink, read in P1): a tail of platform/logs/operations.log.
 * Honestly empty until controlled execution exists — an empty trail is the
 * proof that nothing runs, not a missing feature.
 */
export default function AuditLog({ data }) {
  const { entries, total, path } = data;
  return (
    <div className="panel">
      <div className="label">
        Audit log <span className="label-sub">{total} entries</span>
      </div>
      <div className="wf-summary">tail of {path}</div>
      {entries.length === 0 ? (
        <div className="placeholder-body">
          No audit entries — nothing is executable until Phase 3, so there is nothing to
          audit yet (ADR-0001). Executed operations will append one entry each (op, timestamp,
          status, files, output) here.
        </div>
      ) : (
        <div className="audit-list">
          {entries.map((entry, i) => (
            <div className="audit-entry" key={i}>
              {entry.raw ?? JSON.stringify(entry)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
