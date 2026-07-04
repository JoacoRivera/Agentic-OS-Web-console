import { ArrowLeft, ExternalLink } from 'lucide-react';
import CopyButtons from './CopyButton.jsx';

const CHECK_STATUS_LABEL = {
  pass: 'pass',
  fail: 'FAIL',
  exempt: 'exempt',
  'n/a': 'n/a',
};

function ChecksTable({ title, checks }) {
  if (checks.length === 0) return null;
  return (
    <>
      <div className="label wf-checks-label">{title}</div>
      <table className="wf-table wf-checks">
        <tbody>
          {checks.map((c) => (
            <tr key={c.id}>
              <td className={`wf-check-status st-check-${c.status.replace('/', '')}`}>
                {CHECK_STATUS_LABEL[c.status]}
              </td>
              <td>{c.label}</td>
              <td className="wf-check-detail">{c.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/**
 * One workflow: rolled-up status, required (objective) checks, informational
 * checks (never status-impacting, ADR-0006), related data files, copy
 * cluster + open-in-Documentation link.
 */
export default function WorkflowDetail({ workflow, onBack, onOpenDoc }) {
  const required = workflow.checks.filter((c) => c.category === 'required');
  const informational = workflow.checks.filter((c) => c.category === 'informational');
  return (
    <div className="panel">
      <div className="wf-detail-head">
        <button className="btn" onClick={onBack}>
          <ArrowLeft size={11} style={{ verticalAlign: '-1px', marginRight: 5 }} />
          Registry
        </button>
        <span className={`wf-status st-${workflow.status}`}>
          <span className="status-dot" /> {workflow.statusLabel}
        </span>
        <span className="wf-detail-title">{workflow.title ?? workflow.name}</span>
      </div>
      <table className="kv">
        <tbody>
          <tr>
            <td>Path</td>
            <td>
              <button className="doc-link" onClick={() => onOpenDoc(workflow.path)} title="Open in Documentation">
                {workflow.path}
                <ExternalLink size={10} style={{ verticalAlign: '-1px', marginLeft: 5 }} />
              </button>
            </td>
          </tr>
          <tr>
            <td>Kind</td>
            <td>
              {workflow.kind ?? 'Unclassified — no workflow_kind frontmatter (never inferred, ADR-0007)'}
              {workflow.kind && (
                <span className="dim">
                  {' '}
                  · verification {workflow.requiresVerification ? 'required' : 'not required'} · runbook shape{' '}
                  {workflow.requiresRunbookShape ? 'required' : 'not required'}
                </span>
              )}
            </td>
          </tr>
          <tr>
            <td>Updated</td>
            <td>{workflow.mtime.slice(0, 10)}</td>
          </tr>
          {workflow.checksExempt.length > 0 && (
            <tr>
              <td>Exempt</td>
              <td>{workflow.checksExempt.join(', ')}</td>
            </tr>
          )}
        </tbody>
      </table>
      <ChecksTable title="Objective checks (status-impacting)" checks={required} />
      <ChecksTable title="Informational (never turns the row yellow)" checks={informational} />
      {workflow.relatedFiles.length > 0 && (
        <>
          <div className="label wf-checks-label">Related data (no status verdicts)</div>
          <ul className="wf-related">
            {workflow.relatedFiles.map((f) => (
              <li key={f}>
                {f.endsWith('.md') ? (
                  <button className="doc-link" onClick={() => onOpenDoc(f)}>
                    {f}
                  </button>
                ) : (
                  <span className="dim">{f}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <CopyButtons relPath={workflow.path} absPath={workflow.absolutePath} />
    </div>
  );
}
