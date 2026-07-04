import { ExternalLink } from 'lucide-react';
import CommandPreview from './CommandPreview.jsx';

/**
 * Operations catalog (ADR-0001), read-only in P1. Guided operations render
 * as checklist + command preview (copy only); executable operations are the
 * described Phase-3 allowlist — nothing here runs anything.
 */
export default function OperationsPanel({ data, onOpenDoc }) {
  const { operations, counts, note } = data;
  const guided = operations.filter((op) => op.type === 'guided');
  const executable = operations.filter((op) => op.type === 'executable');

  const card = (op) => (
    <div className="skill-card" key={op.id}>
      <div className="skill-head">
        <span className="skill-name">{op.title}</span>
        <span className={`chip ${op.type === 'guided' ? '' : 'warn'}`}>
          {op.type === 'guided' ? 'guided' : 'executable · P3'}
        </span>
        {op.skill && <span className="skill-invocation">/{op.skill}</span>}
        {op.migrationOnly && <span className="chip warn">migration-only</span>}
      </div>
      {op.description && <div className="skill-desc">{op.description}</div>}
      {op.checklist.length > 0 && (
        <ol className="op-checklist">
          {op.checklist.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ol>
      )}
      <CommandPreview command={op.commandPreview} />
      {op.workflow && (
        <div className="skill-meta">
          <button className="doc-link" onClick={() => onOpenDoc(op.workflow)} title="Open in Documentation">
            {op.workflow}
            <ExternalLink size={10} style={{ verticalAlign: '-1px', marginLeft: 5 }} />
          </button>
        </div>
      )}
    </div>
  );

  return (
    <>
      <div className="panel">
        <div className="label">
          Guided operations <span className="label-sub">{counts.guided}</span>
        </div>
        <div className="notice-compact">{note}</div>
        {guided.map(card)}
      </div>
      <div className="panel">
        <div className="label">
          Executable allowlist <span className="label-sub">{counts.executable} · Phase 3</span>
        </div>
        <div className="wf-summary">
          Deterministic checks only — no LLM Skill is ever executable. Until Phase 3, run and
          dry-run return 501.
        </div>
        {executable.map(card)}
      </div>
    </>
  );
}
