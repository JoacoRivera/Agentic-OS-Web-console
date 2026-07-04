export default function SettingsView({ status, poll, onPollChange }) {
  return (
    <>
      <div className="notice">
        <span>▲</span>
        <span>
          This is a <strong>localhost-only private console</strong>. It binds loopback, rejects
          non-loopback Host headers and cross-origin requests, and refuses to start on a
          non-loopback HOST without auth (ADR-0005). It is <strong>not safe</strong> for
          LAN/public exposure.
        </span>
      </div>
      <div className="panel" style={{ marginTop: 16 }}>
        <div className="label">Runtime</div>
        <table className="kv">
          <tbody>
            <tr>
              <td>Server</td>
              <td>{status ? `http://${status.host}:${status.port}` : 'offline'}</td>
            </tr>
            <tr>
              <td>Repo root</td>
              <td>{status?.repoRoot ?? '—'}</td>
            </tr>
            <tr>
              <td>Raw content over HTTP</td>
              <td>
                {status ? (status.exposeRawContent ? 'exposed (EXPOSE_RAW_CONTENT=true)' : 'hidden (default)') : '—'}
                <div className="muted">Gates raw content only; raw metrics are always computed.</div>
              </td>
            </tr>
            <tr>
              <td>Auto-refresh</td>
              <td>
                <label className="toggle">
                  <input type="checkbox" checked={poll} onChange={(e) => onPollChange(e.target.checked)} />
                  poll every {status ? Math.round(status.refreshMs / 1000) : 30}s
                </label>
                <div className="muted">Reads are live — refresh is simply “fetch again” (no cache).</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="panel">
        <div className="label">Theme</div>
        <div className="placeholder-body">
          Odysseus tokens live in <code>src/theme.css</code>: dark slate background, muted coral
          accent <code>#e08a8a</code>, monospace type, glowing status dots, 1px-bordered rounded
          panels. Edit the <code>:root</code> variables to retheme.
        </div>
      </div>
    </>
  );
}
