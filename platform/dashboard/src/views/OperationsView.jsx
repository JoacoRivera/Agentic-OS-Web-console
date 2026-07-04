import { useEffect, useState } from 'react';
import OperationsPanel from '../components/OperationsPanel.jsx';

/**
 * Operations section (placeholder for P2 guided flows): the typed catalog
 * from /api/operations, rendered read-only — no execution path exists.
 */
export default function OperationsView({ refreshKey = 0, onOpenDoc }) {
  const [data, setData] = useState(null);
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

  return <OperationsPanel data={data} onOpenDoc={onOpenDoc} />;
}
