/**
 * Captures ingested since the last maintenance pass, grouped by capture origin
 * (`health.sincePass`). The Memory Bridge writes captures nobody confirmed
 * (memory repo ADR-0003), so the weekly pass is where the owner skims them.
 * Origin is an attribute, not a state: "Other captures" are not "user-approved"
 * — the console does not guess. Paths only; raw content stays gated (ADR-0005).
 * Renders nothing when no pass is on record (or an older server sends no list).
 */
export default function SincePassCaptures({ metrics }) {
  const sincePass = metrics?.health?.sincePass;
  if (!sincePass) return null;
  const { byOrigin, items, truncated } = sincePass;
  const total = byOrigin.bridge + byOrigin.other;
  const bridge = items.filter((i) => i.origin === 'bridge');
  const other = items.filter((i) => i.origin !== 'bridge');
  const rows = (list) =>
    list.map((i) => (
      <div key={i.path} className="run">
        <span className="run-time">{i.ingestedOn}</span>
        <span className="run-name" title={i.path}>
          {i.name}
        </span>
        <span className="run-path">{i.path}</span>
      </div>
    ));
  return (
    <div className="panel">
      <div className="label">
        Ingested since the last pass · by origin
        <span className="label-sub">{total} since {metrics.health.lastPass}</span>
      </div>
      <div className="label">
        Memory Bridge ({byOrigin.bridge})
        <span className="label-sub">automatic capture · no user confirmed the result · memory repo ADR-0003</span>
      </div>
      {byOrigin.bridge === 0 ? (
        <div className="placeholder-body dim">None from the Memory Bridge since the last pass</div>
      ) : (
        rows(bridge)
      )}
      {byOrigin.other > 0 && (
        <>
          <div className="label">Other captures ({byOrigin.other})</div>
          {rows(other)}
        </>
      )}
      {truncated && (
        <div className="placeholder-body">
          Showing {items.length} of {total}
        </div>
      )}
    </div>
  );
}
