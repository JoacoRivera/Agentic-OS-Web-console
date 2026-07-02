import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import Sidebar from './components/Sidebar.jsx';
import OverviewView from './views/OverviewView.jsx';
import PlaceholderView from './views/PlaceholderView.jsx';
import SettingsView from './views/SettingsView.jsx';
import { SECTIONS } from './sections.js';

const DEFAULT_REFRESH_MS = 30000;

export default function App() {
  const [sectionId, setSectionId] = useState('overview');
  const [status, setStatus] = useState(null);
  const [poll, setPoll] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/status');
      setStatus(res.ok ? await res.json() : null);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    refresh();
    if (!poll) return undefined;
    const interval = setInterval(refresh, status?.refreshMs ?? DEFAULT_REFRESH_MS);
    return () => clearInterval(interval);
  }, [refresh, poll, status?.refreshMs]);

  const section = SECTIONS.find((s) => s.id === sectionId);

  let view;
  if (sectionId === 'overview') {
    view = <OverviewView status={status} />;
  } else if (sectionId === 'settings') {
    view = <SettingsView status={status} poll={poll} onPollChange={setPoll} />;
  } else {
    view = <PlaceholderView section={section} />;
  }

  return (
    <div className="app">
      <Sidebar section={sectionId} onSelect={setSectionId} ready={Boolean(status)} />
      <div className="main">
        <header className="topbar">
          <span className="topbar-title">{section.label}</span>
          <div className="topbar-right">
            <span className={`chip ${status ? 'ok' : 'warn'}`}>
              <span className="status-dot" />
              {status ? 'ready' : 'offline'}
            </span>
            <button className="btn" onClick={refresh} title="Reads are live — refresh is simply fetch again">
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
