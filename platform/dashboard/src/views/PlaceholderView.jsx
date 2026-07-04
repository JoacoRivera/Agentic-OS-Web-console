const COPY = {
  documentation: 'Docs explorer (tree, viewer, search, backlinks) lands with issues #4 and #9.',
  workflows: 'Workflow registry + objective-defect checks land with issue #5.',
  skills: 'Skill registry (the five repo skills, scanned from .claude/skills/) lands with issue #6.',
  'review-queue': 'Draft-capture review queue lands with issue #8.',
  'memory-health': 'Memory health (lint age, staleness) lands with the metrics slice (issue #3).',
  activity: 'Recent activity (7-day bars, latest files) lands with the metrics slice (issue #3).',
  operations:
    'Phase 2 — Guided Operations: checklists + command previews, copy-only, no execution. ' +
    'The console never executes LLM Skills (ADR-0001); execution endpoints return 501 until Phase 3.',
  'audit-log':
    'Phase 3 — audit log of executable operations (dry-run + confirm + diff + audit trail). ' +
    'Nothing is executable yet; POST /api/operations/:id/run returns 501.',
};

export default function PlaceholderView({ section }) {
  return (
    <div className="panel">
      <div className="label">
        {section.label}
        {section.phase > 1 && <span className="label-sub">phase {section.phase}</span>}
      </div>
      <div className="placeholder-body">{COPY[section.id] ?? 'Coming in a later slice.'}</div>
    </div>
  );
}
