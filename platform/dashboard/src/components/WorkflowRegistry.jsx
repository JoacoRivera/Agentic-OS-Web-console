const STATUS_ORDER = ['missing-links', 'needs-review', 'unclassified', 'stale', 'ok'];

/** `2 OK / 1 needs review / 3 unclassified` — zero-count statuses omitted. */
export function summaryLine(summary) {
  return STATUS_ORDER.filter((id) => summary[id] > 0)
    .map((id) => `${summary[id]} ${id === 'ok' ? 'OK' : id.replace('-', ' ')}`)
    .join(' / ');
}

/**
 * Workflow registry table (ADR-0006/0007): status from objective defects
 * only; an un-annotated row reads Unclassified, never green.
 */
export default function WorkflowRegistry({ data, selected, onSelect }) {
  const { workflows, summary } = data;
  const rows = [...workflows].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.path.localeCompare(b.path)
  );
  return (
    <div className="panel">
      <div className="label">Workflow registry</div>
      <div className="wf-summary">
        {summary.total} workflows · {summaryLine(summary) || 'none found'}
      </div>
      {rows.length === 0 ? (
        <div className="placeholder-body">No workflow docs under wiki/workflows/.</div>
      ) : (
        <table className="wf-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Workflow</th>
              <th>Kind</th>
              <th>Failing</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => (
              <tr
                key={w.path}
                className={w.path === selected ? 'selected' : ''}
                onClick={() => onSelect(w.path)}
                title={w.path}
              >
                <td>
                  <span className={`wf-status st-${w.status}`}>
                    <span className="status-dot" /> {w.statusLabel}
                  </span>
                </td>
                <td className="wf-name">{w.name}</td>
                <td className="wf-kind">{w.kind ?? '—'}</td>
                <td className="wf-failing">{w.failingRequired > 0 ? w.failingRequired : ''}</td>
                <td className="wf-mtime">{w.mtime.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
