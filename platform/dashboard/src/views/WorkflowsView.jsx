import { useEffect, useState } from 'react';
import WorkflowRegistry from '../components/WorkflowRegistry.jsx';
import WorkflowDetail from '../components/WorkflowDetail.jsx';

/**
 * Workflows section: registry table ↔ per-workflow detail. Live reads —
 * the registry refreshes on mount/refresh; detail is fetched per selection
 * via /api/workflow?path= (query param — workflow paths contain slashes).
 */
export default function WorkflowsView({ refreshKey = 0, onOpenDoc }) {
  const [registry, setRegistry] = useState(null);
  const [registryError, setRegistryError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/workflows');
        if (cancelled) return;
        if (res.ok) {
          setRegistry(await res.json());
          setRegistryError(null);
        } else {
          const body = await res.json().catch(() => ({}));
          setRegistryError(body.message || `HTTP ${res.status}`);
        }
      } catch (err) {
        if (!cancelled) setRegistryError(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return undefined;
    }
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    (async () => {
      try {
        const res = await fetch(`/api/workflow?path=${encodeURIComponent(selected)}`);
        if (cancelled) return;
        if (res.ok) {
          setDetail(await res.json());
        } else {
          const body = await res.json().catch(() => ({}));
          setDetailError(body.message || `HTTP ${res.status}`);
        }
      } catch (err) {
        if (!cancelled) setDetailError(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, refreshKey]);

  if (selected) {
    if (detail) {
      return <WorkflowDetail workflow={detail} onBack={() => setSelected(null)} onOpenDoc={onOpenDoc} />;
    }
    return (
      <div className="panel">
        <div className="label">Workflow</div>
        <div className="placeholder-body">
          {detailError ? `Workflow unavailable — ${detailError}` : 'Loading workflow…'}
        </div>
      </div>
    );
  }

  if (!registry) {
    return (
      <div className="panel">
        <div className="label">Workflow registry</div>
        <div className="placeholder-body">
          {registryError ? `Registry unavailable — ${registryError}` : 'Loading workflow registry…'}
        </div>
      </div>
    );
  }

  return <WorkflowRegistry data={registry} selected={selected} onSelect={setSelected} />;
}
