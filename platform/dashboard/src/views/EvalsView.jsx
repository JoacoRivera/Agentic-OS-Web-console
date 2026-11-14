import { useEffect, useState } from 'react';
import EvalHistory from '../components/EvalHistory.jsx';

/**
 * Evals section: a live scan of wiki/workflows/evals per fetch — the
 * verdicts the owner recorded, never run or judged here (ADR-0001).
 */
export default function EvalsView({ refreshKey = 0, onOpenDoc }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/evals');
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
        <div className="label">Evals</div>
        <div className="placeholder-body">
          {error ? `Evals unavailable — ${error}` : 'Loading recorded eval verdicts…'}
        </div>
      </div>
    );
  }

  return <EvalHistory data={data} onOpenDoc={onOpenDoc} />;
}
