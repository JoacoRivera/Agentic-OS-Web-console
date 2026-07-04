import { useEffect, useState } from 'react';

export default function Hero({ status, metrics }) {
  // Command bar lists what the skill registry actually finds — never a
  // hardcoded (potentially phantom) list. Empty until loaded / on error.
  const [invocations, setInvocations] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/skills');
        if (!cancelled && res.ok) {
          setInvocations((await res.json()).skills.map((s) => s.invocation));
        }
      } catch {
        /* server offline — the ready chip already says so */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <div className="panel hero">
      <div className="peak">⌃</div>
      <h1>Agentic OS</h1>
      <div className="sub">Memory console — canonical metrics · guided ops, no execution (P2)</div>
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
        {invocations.map((s) => (
          <span key={s} className="chip">{s}</span>
        ))}
      </div>
    </div>
  );
}
