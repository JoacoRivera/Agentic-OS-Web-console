import GuidedOperationCard from './GuidedOperationCard.jsx';
import CommandPreview from './CommandPreview.jsx';

/**
 * Operations catalog (ADR-0001). Guided operations are interactive flows in
 * Phase 2 — checkable checklists + param fill-ins feeding the copyable
 * command preview; executable operations are the described Phase-3 allowlist.
 * Nothing here runs anything.
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
          Deterministic checks only — no LLM Skill is ever executable. Until Phase 3, run and
          dry-run return 501.
        </div>
        {executable.map((op) => (
          <div className="skill-card" key={op.id}>
            <div className="skill-head">
              <span className="skill-name">{op.title}</span>
              <span className="chip warn">executable · P3</span>
              {op.migrationOnly && <span className="chip warn">migration-only</span>}
            </div>
            {op.description && <div className="skill-desc">{op.description}</div>}
            <CommandPreview command={op.commandPreview} />
          </div>
        ))}
      </div>
    </>
  );
}
