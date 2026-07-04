import { useState } from 'react';
import CommandPreview from './CommandPreview.jsx';

/**
 * An executable operation (Phase 3, ADR-0001): one allowlisted deterministic
 * check behind the full safety flow — dry-run first (shows the fixed command
 * and issues a single-use confirm token), then an explicit confirm, then the
 * run with its streams, changed files, and git diff. The id only selects a
 * server-side command-table row; nothing typed here reaches a shell.
 */
export default function ExecutableOperationCard({ op }) {
  const [dry, setDry] = useState(null); // dry-run response awaiting confirm
  const [result, setResult] = useState(null); // last run response
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const post = async (suffix, body) => {
    const res = await fetch(`/api/operations/${encodeURIComponent(op.id)}/${suffix}`, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);
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

  const doRun = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await post('run', { confirm: true, confirmToken: dry.confirmToken }));
      setDry(null);
    } catch (err) {
      setError(err.message);
      setDry(null); // the token is single-use — a failed confirm needs a fresh dry-run
    } finally {
      setBusy(false);
    }
  };

  const statusChip =
    result &&
    { ok: 'chip ok', failed: 'chip warn', timeout: 'chip warn' }[result.status];

  return (
    <div className="skill-card">
      <div className="skill-head">
        <span className="skill-name">{op.title}</span>
        <span className="chip">executable</span>
        {op.migrationOnly && <span className="chip warn">migration-only</span>}
        {result && <span className={statusChip}>{result.status}</span>}
      </div>
      {op.description && <div className="skill-desc">{op.description}</div>}
      <CommandPreview command={op.commandPreview} />

      <div className="exec-actions">
        {!dry && (
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
              {busy ? 'running…' : 'confirm & run'}
            </button>
            <button className="btn" onClick={() => setDry(null)} disabled={busy}>
              cancel
            </button>
          </div>
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
