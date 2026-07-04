import { useEffect, useState } from 'react';
import AuditLog from '../components/AuditLog.jsx';

/** Audit section (placeholder until P3 execution): tail of /api/audit. */
export default function AuditLogView({ refreshKey = 0 }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/audit');
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
        <div className="label">Audit log</div>
        <div className="placeholder-body">
          {error ? `Audit log unavailable — ${error}` : 'Loading audit log…'}
        </div>
      </div>
    );
  }

  return <AuditLog data={data} />;
}
