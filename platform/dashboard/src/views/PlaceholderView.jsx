const COPY = {
  workflows: 'Workflow registry + objective-defect checks land with issue #5.',
  skills: 'Skill registry (the five repo skills, scanned from .claude/skills/) lands with issue #6.',
  'memory-health': 'Memory health (lint age, staleness) lands with the metrics slice (issue #3).',
  activity: 'Recent activity (7-day bars, latest files) lands with the metrics slice (issue #3).',
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
