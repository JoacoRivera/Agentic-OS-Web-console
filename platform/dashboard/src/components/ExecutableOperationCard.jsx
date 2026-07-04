import { useEffect, useRef, useState } from 'react';
import CommandPreview from './CommandPreview.jsx';

/**
 * An executable operation (Phase 3, ADR-0001): one allowlisted deterministic
 * check behind the full safety flow — dry-run first (shows the fixed command
 * and issues a single-use confirm token), then an explicit confirm, then an
 * async run (202 + runId, roadmap §4.2) whose output streams live over SSE,
 * with changed files and git diff at completion. The id only selects a
 * server-side command-table row; nothing typed here reaches a shell.
 */
export default function ExecutableOperationCard({ op, lastRun }) {
  const [dry, setDry] = useState(null); // dry-run response awaiting confirm
  const [live, setLive] = useState(null); // { runId, text } while streaming
  const [result, setResult] = useState(null); // final run snapshot
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const sourceRef = useRef(null);
  const streamRef = useRef(null);

  useEffect(() => () => sourceRef.current?.close(), []);
  useEffect(() => {
    streamRef.current?.scrollTo(0, streamRef.current.scrollHeight);
  }, [live]);

  const post = async (suffix, body) => {
    const res = await fetch(`/api/operations/${encodeURIComponent(op.id)}/${suffix}`, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 202) throw new Error(json.message || `HTTP ${res.status}`);
    return json;
  };

  const doDryRun = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setDry(await post('dry-run'));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const finish = (snapshot) => {
    sourceRef.current?.close();
    sourceRef.current = null;
    setLive(null);
    setResult(snapshot);
    setBusy(false);
  };

  // Fallback when SSE drops: poll the snapshot route until the run ends.
  const pollUntilDone = async (runId) => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await fetch(`/api/operations/runs/${runId}`);
      if (!res.ok) throw new Error(`run lost (HTTP ${res.status})`);
      const snap = await res.json();
      if (snap.status !== 'running') return snap;
    }
  };

  const doRun = async () => {
    setBusy(true);
    setError(null);
    try {
      const started = await post('run', { confirm: true, confirmToken: dry.confirmToken });
      setDry(null);
      setLive({ runId: started.runId, text: '' });

      const source = new EventSource(`/api/operations/runs/${started.runId}/events`);
      sourceRef.current = source;
      source.addEventListener('output', (e) => {
        const { chunk } = JSON.parse(e.data);
        setLive((prev) => (prev ? { ...prev, text: prev.text + chunk } : prev));
      });
      source.addEventListener('done', (e) => finish(JSON.parse(e.data)));
      source.onerror = () => {
        source.close();
        pollUntilDone(started.runId).then(finish, (err) => {
          setError(err.message);
          setLive(null);
          setBusy(false);
        });
      };
    } catch (err) {
      setError(err.message);
      setDry(null); // the token is single-use — a failed confirm needs a fresh dry-run
      setBusy(false);
    }
  };

  const statusChip =
    result && { ok: 'chip ok', failed: 'chip warn', timeout: 'chip warn' }[result.status];

  return (
    <div className="skill-card">
      <div className="skill-head">
        <span className="skill-name">{op.title}</span>
        <span className="chip">executable</span>
        {op.migrationOnly && <span className="chip warn">migration-only</span>}
        {live && <span className="chip warn">running</span>}
        {result && <span className={statusChip}>{result.status}</span>}
      </div>
      {op.description && <div className="skill-desc">{op.description}</div>}
      <CommandPreview command={op.commandPreview} />

      {!result && !live && lastRun && (
        <div className="exec-result-meta">
          last run: {lastRun.ts} · {lastRun.status}
          {lastRun.exitCode !== undefined && lastRun.exitCode !== null && ` · exit ${lastRun.exitCode}`}
        </div>
      )}

      <div className="exec-actions">
        {!dry && !live && (
          <button className="btn" onClick={doDryRun} disabled={busy}>
            {busy ? 'working…' : 'dry-run'}
          </button>
        )}
        {error && <span className="exec-error">{error}</span>}
      </div>

      {dry && (
        <div className="exec-confirm">
          <div className="exec-confirm-text">
            Dry-run only — nothing was executed. Confirm to run{' '}
            <code>{dry.command}</code> in <code>{dry.cwd}</code>.
          </div>
          <div className="exec-actions">
            <button className="btn exec-run-btn" onClick={doRun} disabled={busy}>
              {busy ? 'starting…' : 'confirm & run'}
            </button>
            <button className="btn" onClick={() => setDry(null)} disabled={busy}>
              cancel
            </button>
          </div>
        </div>
      )}

      {live && (
        <div className="exec-result">
          <div className="exec-result-meta">streaming · run {live.runId.slice(0, 8)}</div>
          <pre className="exec-stream" ref={streamRef}>
            {live.text || '…'}
          </pre>
        </div>
      )}

      {result && (
        <div className="exec-result">
          <div className="exec-result-meta">
            exit {result.exitCode ?? '—'} · {(result.durationMs / 1000).toFixed(1)}s ·{' '}
            {result.gitAvailable
              ? `${result.changedFiles.length} file(s) changed`
              : 'git status unavailable'}
          </div>
          {result.stdout && <pre className="exec-stream">{result.stdout}</pre>}
          {result.stderr && <pre className="exec-stream exec-stream-err">{result.stderr}</pre>}
          {result.changedFiles?.length > 0 && (
            <div className="exec-changed">
              <div className="label">Changed files</div>
              <pre className="exec-stream">{result.changedFiles.join('\n')}</pre>
              {result.gitDiff && <pre className="exec-stream">{result.gitDiff}</pre>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
