import { useEffect, useState } from 'react';
import SkillRegistry from '../components/SkillRegistry.jsx';

/**
 * Skills section: a live directory scan per fetch — the registry shows
 * exactly the Skills that exist (never a phantom, ADR-0001).
 */
export default function SkillsView({ refreshKey = 0, onOpenDoc }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/skills');
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
        <div className="label">Skill registry</div>
        <div className="placeholder-body">
          {error ? `Registry unavailable — ${error}` : 'Loading skill registry…'}
        </div>
      </div>
    );
  }

  return <SkillRegistry data={data} onOpenDoc={onOpenDoc} />;
}
