import { SECTIONS } from '../sections.js';

export default function Sidebar({ section, onSelect, ready, metrics }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">⌃</span>
        <div>
          <div className="brand-name">Agentic OS</div>
          <div className="brand-sub">Odysseus console</div>
        </div>
      </div>
      <nav className="nav">
        {SECTIONS.map(({ id, label, icon: Icon, phase }) => (
          <button
            key={id}
            className={`nav-item${section === id ? ' active' : ''}`}
            onClick={() => onSelect(id)}
          >
            <Icon size={14} strokeWidth={1.75} />
            {label}
            {phase > 1 && <span className="chip">P{phase}</span>}
            {id === 'overview' && (
              <span className={`chip ${ready ? 'ok' : 'warn'}`}>
                <span className="status-dot" />
                {ready ? 'ready' : 'offline'}
              </span>
            )}
            {id === 'review-queue' && metrics && (
              <span className={`chip ${metrics.draftN > 0 ? 'warn' : 'ok'}`}>
                {metrics.draftN} draft
              </span>
            )}
            {id === 'memory-health' && metrics && (
              <span className={`chip ${metrics.health.healthStale ? 'warn' : 'ok'}`}>
                <span className="status-dot" />
                {metrics.health.healthStale ? 'due' : 'ok'}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="sidebar-foot">
        <div className="notice-compact">
          Localhost-only private console — not safe for LAN/public exposure without auth
          (ADR-0005)
        </div>
      </div>
    </aside>
  );
}
