import { useState } from 'react';
import { ExternalLink, RotateCcw } from 'lucide-react';
import CommandPreview from './CommandPreview.jsx';

const PROGRESS_KEY = (id) => `aos-console:op-progress:${id}`;

function loadProgress(id, length) {
  try {
    const stored = JSON.parse(localStorage.getItem(PROGRESS_KEY(id)));
    if (Array.isArray(stored) && stored.length === length) return stored;
  } catch {
    /* corrupt/absent — start clean */
  }
  return Array(length).fill(false);
}

/**
 * A guided operation as an interactive flow (Phase 2): a checkable checklist
 * whose progress persists per-browser (localStorage), plus param fill-ins
 * substituted into the copyable command preview. Everything stays in the
 * browser — no endpoint accepts checklist state or params, and nothing here
 * runs anything (ADR-0001).
 */
export default function GuidedOperationCard({ op, onOpenDoc }) {
  const [checked, setChecked] = useState(() => loadProgress(op.id, op.checklist.length));
  const [values, setValues] = useState({});

  const done = checked.filter(Boolean).length;
  const complete = done === checked.length && checked.length > 0;

  const toggle = (i) => {
    const next = checked.map((v, j) => (j === i ? !v : v));
    setChecked(next);
    try {
      localStorage.setItem(PROGRESS_KEY(op.id), JSON.stringify(next));
    } catch {
      /* storage denied — progress is session-only */
    }
  };

  const reset = () => {
    setChecked(Array(op.checklist.length).fill(false));
    setValues({});
    try {
      localStorage.removeItem(PROGRESS_KEY(op.id));
    } catch {
      /* ignore */
    }
  };

  const command = op.params.reduce(
    (text, param) =>
      values[param.name] ? text.replaceAll(`<${param.name}>`, values[param.name]) : text,
    op.commandPreview
  );

  return (
    <div className="skill-card">
      <div className="skill-head">
        <span className="skill-name">{op.title}</span>
        <span className="chip">guided</span>
        {op.skill && <span className="skill-invocation">/{op.skill}</span>}
        <span className={`chip op-progress-chip ${complete ? 'ok' : ''}`}>
          {done}/{checked.length}
        </span>
        {done > 0 && (
          <button className="btn op-reset" onClick={reset} title="Uncheck all steps">
            <RotateCcw size={10} style={{ verticalAlign: '-1px', marginRight: 4 }} />
            reset
          </button>
        )}
      </div>
      {op.description && <div className="skill-desc">{op.description}</div>}
      <div className="op-progress-track">
        <div className="op-progress-fill" style={{ width: `${(done / checked.length) * 100}%` }} />
      </div>
      <ul className="op-steps">
        {op.checklist.map((item, i) => (
          <li key={i}>
            <label className={`op-step${checked[i] ? ' done' : ''}`}>
              <input type="checkbox" checked={checked[i]} onChange={() => toggle(i)} />
              <span>{item}</span>
            </label>
          </li>
        ))}
      </ul>
      {op.params.map((param) => (
        <div className="op-param" key={param.name}>
          <span className="op-param-label">{param.label}</span>
          {param.options ? (
            <select
              className="op-param-input"
              value={values[param.name] ?? ''}
              onChange={(e) => setValues({ ...values, [param.name]: e.target.value })}
            >
              <option value="">{`<${param.name}>`}</option>
              {param.options.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="op-param-input"
              type="text"
              placeholder={param.hint || `<${param.name}>`}
              value={values[param.name] ?? ''}
              onChange={(e) => setValues({ ...values, [param.name]: e.target.value })}
              spellCheck={false}
            />
          )}
        </div>
      ))}
      <CommandPreview command={command} />
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
}
