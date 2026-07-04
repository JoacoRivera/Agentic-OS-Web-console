import { useEffect, useState } from 'react';
import OperationsPanel from '../components/OperationsPanel.jsx';

/**
 * Operations section: the typed catalog from /api/operations. Guided flows
 * render as interactive checklists + copyable command previews; executable
 * allowlist entries carry the dry-run → confirm → streamed-run flow, plus a
 * "last run" line derived from the audit tail (roadmap §4.3).
 */
export default function OperationsView({ refreshKey = 0, onOpenDoc }) {
  const [data, setData] = useState(null);
  const [lastRuns, setLastRuns] = useState({});
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/operations');
        if (cancelled) return;
        if (res.ok) {
          setData(await res.json());
          setError(null);
        } else {
          const body = await res.json().catch(() => ({}));
          setError(body.message || `HTTP ${res.status}`);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
      // Last run per operation, from the audit tail — best-effort: the
      // cards render fine without it.
      try {
        const res = await fetch('/api/audit');
        if (cancelled || !res.ok) return;
        const { entries } = await res.json();
        const byOp = {};
        for (const entry of entries) if (entry.op) byOp[entry.op] = entry;
        setLastRuns(byOp);
      } catch {
        /* audit unavailable — cards show no last-run line */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (!data) {
    return (
      <div className="panel">
        <div className="label">Operations</div>
        <div className="placeholder-body">
          {error ? `Catalog unavailable — ${error}` : 'Loading operations catalog…'}
        </div>
      </div>
    );
  }

  return <OperationsPanel data={data} lastRuns={lastRuns} onOpenDoc={onOpenDoc} />;
}
