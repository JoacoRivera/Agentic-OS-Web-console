import GuidedOperationCard from './GuidedOperationCard.jsx';
import ExecutableOperationCard from './ExecutableOperationCard.jsx';

/**
 * Operations catalog (ADR-0001). Guided operations are interactive flows —
 * checkable checklists + param fill-ins feeding the copyable command preview
 * (never run). Executable operations are the Phase-3 deterministic allowlist,
 * live behind dry-run → explicit confirm → audited run.
 */
export default function OperationsPanel({ data, onOpenDoc }) {
  const { operations, counts, note } = data;
  const guided = operations.filter((op) => op.type === 'guided');
  const executable = operations.filter((op) => op.type === 'executable');

  return (
    <>
      <div className="panel">
        <div className="label">
          Guided operations <span className="label-sub">{counts.guided}</span>
        </div>
        <div className="notice-compact">{note}</div>
        {guided.map((op) => (
          <GuidedOperationCard key={op.id} op={op} onOpenDoc={onOpenDoc} />
        ))}
      </div>
      <div className="panel">
        <div className="label">
          Executable allowlist <span className="label-sub">{counts.executable} · Phase 3</span>
        </div>
        <div className="wf-summary">
          Deterministic checks only — no LLM Skill is ever executable. Every run is dry-run
          first, explicitly confirmed, one at a time, and appended to the audit log.
        </div>
        {executable.map((op) => (
          <ExecutableOperationCard key={op.id} op={op} />
        ))}
      </div>
    </>
  );
}
