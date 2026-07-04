const SKILLS = ['/ingest', '/query-memory', '/wiki-lint', '/capture-approved-example', '/promote-draft-memory'];

export default function Hero({ status, metrics }) {
  return (
    <div className="panel hero">
      <div className="peak">⌃</div>
      <h1>Agentic OS</h1>
      <div className="sub">Memory console — canonical metrics · read-only (P1)</div>
      <div className="ready">
        <span className={`chip ${status ? 'ok' : 'warn'}`}>
          <span className="status-dot" />
          {status ? `ready · ${new Date(status.now).toLocaleTimeString()}` : 'server offline'}
        </span>
        {metrics && (
          <>
            <span className="chip">{metrics.capN} captures</span>
            <span className={`chip ${metrics.draftN > 0 ? 'warn' : 'ok'}`}>
              <span className="status-dot" />
              {metrics.draftN > 0 ? `${metrics.draftN} to review` : 'all reviewed'}
            </span>
            <span className="chip">{metrics.apprN} approved</span>
            <span className="chip">{metrics.trend}</span>
          </>
        )}
      </div>
      <div className="commandbar">
        {SKILLS.map((s) => (
          <span key={s} className="chip">{s}</span>
        ))}
      </div>
    </div>
  );
}
