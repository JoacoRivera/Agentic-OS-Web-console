import { ExternalLink } from 'lucide-react';
import CopyButtons, { CopyButton } from './CopyButton.jsx';

/**
 * Skill registry (ADR-0001): exactly what the directory scan found — Skills
 * are LLM capability packs, invoked by Claude via /name. Copy-invocation
 * only; the console never executes a Skill, so there is no run button.
 */
export default function SkillRegistry({ data, onOpenDoc }) {
  const { skills, total, root } = data;
  return (
    <div className="panel">
      <div className="label">Skill registry</div>
      <div className="wf-summary">
        {total} skills found · scanned live from {root}/
      </div>
      <div className="notice-compact skill-notice">
        Skills need LLM judgment and are never console-executable — invoke them in Claude by
        copying the /name below (ADR-0001)
      </div>
      {skills.length === 0 ? (
        <div className="placeholder-body">No SKILL.md files under {root}/.</div>
      ) : (
        skills.map((s) => (
          <div className="skill-card" key={s.name}>
            <div className="skill-head">
              <span className="skill-name">{s.name}</span>
              <span className="skill-invocation">{s.invocation}</span>
              <CopyButton label="copy invocation" value={s.invocation} />
              <span className="chip">not console-executable</span>
              <span className="skill-mtime">{s.mtime.slice(0, 10)}</span>
            </div>
            {s.description && <div className="skill-desc">{s.description}</div>}
            <div className="skill-meta">
              <button className="doc-link" onClick={() => onOpenDoc(s.path)} title="Open in Documentation">
                {s.path}
                <ExternalLink size={10} style={{ verticalAlign: '-1px', marginLeft: 5 }} />
              </button>
              {s.relatedWorkflow && (
                <span className="dim">
                  related workflow (guessed):{' '}
                  <button className="doc-link" onClick={() => onOpenDoc(s.relatedWorkflow)}>
                    {s.relatedWorkflow}
                  </button>
                </span>
              )}
            </div>
            <CopyButtons relPath={s.path} absPath={s.absolutePath} />
          </div>
        ))
      )}
    </div>
  );
}
