import { useEffect, useState } from 'react';
import { CopyButton } from '../components/CopyButton.jsx';

/**
 * Session Status: what the memory repo's `scripts/aos_status.py` prints at
 * session start — maintenance pass, capture queue, git state of the clone,
 * setup — computed live by the server with the same rules. Fetched on mount
 * and on manual refresh only (it runs git; it is not on the metrics poll).
 * A check the console cannot run is shown dim as "not checked" with the
 * command that does run it — never a green dot, never a zero.
 */

const STATE_CLASS = { ok: 'ok', due: 'warn', overdue: 'warn', missing: 'warn', unknown: 'warn' };

function StateChip({ state, label = state }) {
  const cls = STATE_CLASS[state];
  return (
    <span className={`chip${cls ? ` ${cls}` : ''}`}>
      {cls && <span className="status-dot" />}
      {label}
    </span>
  );
}

const days = (n) => (n === null || n === undefined ? null : `${n}d`);

function MaintenancePanel({ m }) {
  const label = m.reason === 'no-log' ? 'unknown' : m.state;
  return (
    <div className="panel">
      <div className="label">
        Maintenance pass
        <StateChip state={m.state} label={label} />
      </div>
      <div className="run">
        <span className={`badge ${m.state === 'ok' ? 'ok' : 'warn'}`}>{label.toUpperCase()}</span>
        <span className="run-name">
          Last pass {m.ageDays !== null && <span className="dim">· {m.ageDays}d ago</span>}
        </span>
        <span className="run-time">{m.lastPass ?? '—'}</span>
      </div>
      <div className="panel-note">
        {m.reason === 'no-log' && <>No <code>wiki/log.md</code> — cannot tell when the last pass ran.</>}
        {m.reason === 'no-pass' && <>No <code>lint | maintenance pass</code> entry in the log — run the maintenance pass (<b>/aos-wiki-lint</b> first).</>}
        {m.reason === 'error' && <>The activity log could not be read.</>}
        {m.reason === null && m.state !== 'ok' && <>Run the maintenance pass{m.state === 'overdue' ? ' — overdue (10+ days)' : ' — due (7+ days)'}.</>}
        {m.reason === null && m.state === 'ok' && <>Within the 7-day cadence.</>}
      </div>
    </div>
  );
}

function CapturesPanel({ c }) {
  if (c.state !== 'ok') {
    return (
      <div className="panel">
        <div className="label">Captures</div>
        <div className="placeholder-body warn-text">Captures unavailable — the capture inventory could not be read.</div>
      </div>
    );
  }
  const oldest = (n) => (n === null ? '' : ` · oldest ${days(n)}`);
  return (
    <div className="panel">
      <div className="label">
        Captures
        <StateChip state={c.draftN ? 'due' : 'ok'} label={c.draftN ? `${c.draftN} draft` : 'no draft'} />
      </div>
      <table className="kv">
        <tbody>
          <tr>
            <td>Draft waiting</td>
            <td className={c.draftN ? 'warn-text' : ''}>
              {c.draftN ? `${c.draftN} for /aos-ingest${oldest(c.oldestDraftDays)}` : 'none'}
            </td>
          </tr>
          <tr>
            <td>Ingested since the last pass</td>
            <td>
              {c.ingestedSincePass === null ? (
                <span className="dim">n/a — no maintenance pass on record</span>
              ) : (
                <>
                  {c.ingestedSincePass}
                  <span className="muted"> · since {c.lastPass}</span>
                </>
              )}
            </td>
          </tr>
          <tr>
            <td>On hold</td>
            <td>
              {c.heldN ? `${c.heldN}${oldest(c.oldestHeldDays)} · not overdue` : 'none'}
              {c.holdReasons.length > 0 && <span className="muted"> · {c.holdReasons.join('; ')}</span>}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const GIT_REASON = {
  'git-not-installed': 'git is not installed on the console host — git state unknown.',
  'not-a-repository': 'REPO_ROOT is not a git repository — git state unknown.',
  timeout: 'git did not answer within the time budget — git state unknown.',
  error: 'git failed — git state unknown.',
};

function GitPanel({ g }) {
  if (g.state !== 'ok') {
    return (
      <div className="panel">
        <div className="label">
          Git
          <StateChip state="unknown" label="unavailable" />
        </div>
        <div className="placeholder-body warn-text">{GIT_REASON[g.reason] ?? GIT_REASON.error}</div>
      </div>
    );
  }
  const counts =
    g.upstream === null ? null : g.ahead === null ? 'unknown' : `ahead ${g.ahead} / behind ${g.behind}`;
  return (
    <div className="panel">
      <div className="label">
        Git
        <StateChip state={g.dirtyN ? 'due' : 'ok'} label={g.dirtyN ? 'dirty' : 'clean'} />
      </div>
      <table className="kv">
        <tbody>
          <tr>
            <td>Branch</td>
            <td>{g.branch ?? <span className="warn-text">detached HEAD</span>}</td>
          </tr>
          <tr>
            <td>Upstream</td>
            <td>{g.upstream ?? <span className="dim">none — no remote tracking branch</span>}</td>
          </tr>
          {counts !== null && (
            <tr>
              <td>Ahead / behind</td>
              <td>
                {counts}
                <span className="muted"> · vs {g.upstream}</span>
              </td>
            </tr>
          )}
          <tr>
            <td>Working tree</td>
            <td className={g.dirtyN ? 'warn-text' : ''}>{g.dirtyN ? `${g.dirtyN} dirty file(s)` : 'clean'}</td>
          </tr>
        </tbody>
      </table>
      <div className="panel-note">As of last fetch — the console never fetches.</div>
    </div>
  );
}

const NOT_CHECKED_REASON = {
  'python-environment': 'a fact about the Python environment; the console does not run Python',
  'reads-outside-repo-root': "reads skills/, plugins/ and $HOME — outside the console's allowed roots",
};

function SetupRow({ name, item, ok, problem }) {
  if (item.state === 'not-checked') {
    return (
      <tr>
        <td className="dim">{name}</td>
        <td className="dim">
          <StateChip state="not-checked" label="not checked" />{' '}
          {NOT_CHECKED_REASON[item.reason] ?? item.reason}{' '}
          <CopyButton label="copy cmd" value={item.command} />
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td>{name}</td>
      <td className={item.state === 'ok' ? '' : 'warn-text'}>
        <StateChip state={item.state} /> {item.state === 'ok' ? ok : problem}
      </td>
    </tr>
  );
}

const GITHOOK_UNKNOWN = {
  'git-not-installed': 'git missing',
  timeout: 'skipped (time budget)',
  error: 'unavailable',
};

function SetupPanel({ s }) {
  const { githook, host, lintDeps, skills } = s;
  return (
    <div className="panel">
      <div className="label">Setup</div>
      <table className="kv">
        <tbody>
          <SetupRow
            name="Githook"
            item={githook}
            ok="core.hooksPath = scripts/githooks"
            problem={githook.state === 'missing' ? `missing — ${githook.fix}` : GITHOOK_UNKNOWN[githook.reason] ?? 'unknown'}
          />
          <SetupRow name="Lint deps" item={lintDeps} />
          <SetupRow
            name="Host row"
            item={host}
            ok={`${host.name} in wiki/agentic-os-locations.md`}
            problem={
              host.reason === 'no-locations-page'
                ? 'wiki/agentic-os-locations.md is missing'
                : host.state === 'missing'
                  ? `${host.name} not in wiki/agentic-os-locations.md`
                  : 'unavailable'
            }
          />
          <SetupRow name="Skills sync" item={skills} />
        </tbody>
      </table>
    </div>
  );
}

export default function SessionStatusView({ refreshKey }) {
  const [state, setState] = useState({ data: null, error: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/session-status');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setState({ data, error: null });
      } catch (error) {
        if (!cancelled) setState({ data: null, error: error.message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const { data, error } = state;
  if (!data) {
    return (
      <div className="panel">
        <div className="label">Session status</div>
        <div className={`placeholder-body${error ? ' warn-text' : ''}`}>
          {error ? `Session status unavailable — ${error}` : 'Loading session status…'}
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="panel">
        <div className="label">
          Session status
          <span className="label-sub">
            clone at REPO_ROOT on {data.setup.host.name} · mirrors <code>{data.mirrors}</code> · {data.today}
          </span>
        </div>
        <div className="panel-note">
          What to read at session start. Lint deps and skills sync are not checked here; for the full set run{' '}
          <code>python3 {data.mirrors}</code> <CopyButton label="copy cmd" value={`python3 ${data.mirrors}`} />
        </div>
      </div>
      <div className="grid-2">
        <MaintenancePanel m={data.maintenance} />
        <CapturesPanel c={data.captures} />
      </div>
      <div className="grid-2">
        <GitPanel g={data.git} />
        <SetupPanel s={data.setup} />
      </div>
    </>
  );
}
