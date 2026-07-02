const SKILLS = ['/ingest', '/query-memory', '/wiki-lint', '/capture-approved-example', '/promote-draft-memory'];

export default function OverviewView({ status }) {
  return (
    <>
      <div className="panel hero">
        <div className="peak">⌃</div>
        <h1>Agentic OS</h1>
        <div className="sub">Memory console — canonical metrics · read-only (P1)</div>
        <div className="ready">
          <span className={`chip ${status ? 'ok' : 'warn'}`}>
            <span className="status-dot" />
            {status ? `ready · ${new Date(status.now).toLocaleTimeString()}` : 'server offline'}
          </span>
        </div>
        <div className="commandbar">
          {SKILLS.map((s) => (
            <span key={s} className="chip">{s}</span>
          ))}
        </div>
      </div>
      <div className="panel">
        <div className="label">Metrics</div>
        <div className="placeholder-body">
          Canonical memory metrics (Published memory · Raw capture archive · repository file
          growth · health) land with the metrics slice (issue&nbsp;#3). This shell is the walking
          skeleton: security spine, sidebar, and live server status only.
        </div>
      </div>
    </>
  );
}
