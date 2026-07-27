import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import Sidebar from './components/Sidebar.jsx';
import OverviewView from './views/OverviewView.jsx';
import DocsView from './views/DocsView.jsx';
import WorkflowsView from './views/WorkflowsView.jsx';
import SkillsView from './views/SkillsView.jsx';
import OperationsView from './views/OperationsView.jsx';
import AuditLogView from './views/AuditLogView.jsx';
import PlaceholderView from './views/PlaceholderView.jsx';
import ReviewQueueView from './views/ReviewQueueView.jsx';
import MemoryHealthView from './views/MemoryHealthView.jsx';
import MemoryQueryView from './views/MemoryQueryView.jsx';
import ActivityView from './views/ActivityView.jsx';
import SettingsView from './views/SettingsView.jsx';
import { SECTIONS } from './sections.js';

const DEFAULT_REFRESH_MS = 30000;

export default function App() {
  const [sectionId, setSectionId] = useState('overview');
  const [status, setStatus] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [metricsError, setMetricsError] = useState(null);
  const [poll, setPoll] = useState(true);
  const [manualRefreshKey, setManualRefreshKey] = useState(0);
  // "Open file" from another section: switch to Documentation showing `path`.
  // A counter key so re-opening the same path still triggers navigation.
  const [docRequest, setDocRequest] = useState(null);

  // Live reads (plan): refresh is simply "fetch again" — no cache semantics.
  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/status');
      setStatus(res.ok ? await res.json() : null);
    } catch {
      setStatus(null);
    }
    try {
      const res = await fetch('/api/metrics');
      if (res.ok) {
        setMetrics(await res.json());
        setMetricsError(null);
      } else {
        const body = await res.json().catch(() => ({}));
        setMetrics(null);
        setMetricsError(body.message || `HTTP ${res.status}`);
      }
    } catch (err) {
      setMetrics(null);
      setMetricsError(err.message);
    }
  }, []);

  const manualRefresh = useCallback(async () => {
    await refresh();
    setManualRefreshKey((key) => key + 1);
  }, [refresh]);

  useEffect(() => {
    refresh();
    if (!poll) return undefined;
    const interval = setInterval(refresh, status?.refreshMs ?? DEFAULT_REFRESH_MS);
    return () => clearInterval(interval);
  }, [refresh, poll, status?.refreshMs]);

  const section = SECTIONS.find((s) => s.id === sectionId);

  let view;
  if (sectionId === 'overview') {
    view = <OverviewView status={status} metrics={metrics} metricsError={metricsError} />;
  } else if (sectionId === 'documentation') {
    view = <DocsView refreshKey={manualRefreshKey} openRequest={docRequest} />;
  } else if (sectionId === 'workflows') {
    view = (
      <WorkflowsView
        refreshKey={manualRefreshKey}
        onOpenDoc={(path) => {
          setDocRequest({ path, key: Date.now() });
          setSectionId('documentation');
        }}
      />
    );
  } else if (sectionId === 'skills') {
    view = (
      <SkillsView
        refreshKey={manualRefreshKey}
        onOpenDoc={(path) => {
          setDocRequest({ path, key: Date.now() });
          setSectionId('documentation');
        }}
      />
    );
  } else if (sectionId === 'memory-query') {
    view = (
      <MemoryQueryView
        onOpenDoc={(path) => {
          setDocRequest({ path, key: Date.now() });
          setSectionId('documentation');
        }}
      />
    );
  } else if (sectionId === 'review-queue') {
    view = <ReviewQueueView metrics={metrics} metricsError={metricsError} />;
  } else if (sectionId === 'memory-health') {
    view = <MemoryHealthView metrics={metrics} metricsError={metricsError} />;
  } else if (sectionId === 'activity') {
    view = <ActivityView metrics={metrics} metricsError={metricsError} />;
  } else if (sectionId === 'operations') {
    view = (
      <OperationsView
        refreshKey={manualRefreshKey}
        onOpenDoc={(path) => {
          setDocRequest({ path, key: Date.now() });
          setSectionId('documentation');
        }}
      />
    );
  } else if (sectionId === 'audit-log') {
    view = <AuditLogView refreshKey={manualRefreshKey} />;
  } else if (sectionId === 'settings') {
    view = <SettingsView status={status} poll={poll} onPollChange={setPoll} />;
  } else {
    view = <PlaceholderView section={section} />;
  }

  return (
    <div className="app">
      <Sidebar section={sectionId} onSelect={setSectionId} ready={Boolean(status)} metrics={metrics} />
      <div className="main">
        <header className="topbar">
          <span className="topbar-title">{section.label}</span>
          <div className="topbar-right">
            <span className={`chip ${status ? 'ok' : 'warn'}`}>
              <span className="status-dot" />
              {status ? 'ready' : 'offline'}
            </span>
            <button className="btn" onClick={manualRefresh} title="Reads are live — refresh is simply fetch again">
              <RefreshCw size={11} strokeWidth={2} style={{ verticalAlign: '-1px', marginRight: 6 }} />
              Refresh
            </button>
          </div>
        </header>
        <main className="content">{view}</main>
      </div>
    </div>
  );
}
