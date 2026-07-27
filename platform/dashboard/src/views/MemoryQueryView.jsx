import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Search, X } from 'lucide-react';
import CommandPreview from '../components/CommandPreview.jsx';

const DEBOUNCE_MS = 250;

/**
 * Memory Query section: deterministic tag-based recall over the published
 * wiki (mirrors the aos-query-memory Skill's mechanical half —
 * scripts/wiki-tags.py). This view only *finds* pages; it never invokes
 * Hermes, Claude, Codex, or any Skill (ADR-0001) — the Hermes handoff below
 * is a copy-only command, never something this console runs. raw/ is never
 * searched here, regardless of EXPOSE_RAW_CONTENT (ADR-0005).
 */
export default function MemoryQueryView({ onOpenDoc }) {
  const [topic, setTopic] = useState('');
  const [result, setResult] = useState({ data: null, error: null });
  const requestSequence = useRef(0);

  useEffect(() => {
    const requestId = ++requestSequence.current;
    // Clear any earlier query's results immediately so a stale result never
    // lingers on screen while a new topic is pending — the "Searching…"
    // placeholder below only shows when result.data is null.
    setResult({ data: null, error: null });
    const q = topic.trim();
    if (!q) {
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/memory/query?topic=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        if (res.ok) {
          const data = await res.json();
          if (requestId === requestSequence.current) setResult({ data, error: null });
        } else {
          const body = await res.json().catch(() => ({}));
          if (requestId === requestSequence.current) {
            setResult({ data: null, error: body.message || `HTTP ${res.status}` });
          }
        }
      } catch (err) {
        if (err.name !== 'AbortError' && requestId === requestSequence.current) {
          setResult({ data: null, error: err.message });
        }
      }
    }, DEBOUNCE_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [topic]);

  const searching = topic.trim().length > 0;
  const handoffCommand = `/hermes-aos aos-query-memory ${topic.trim() || '<topic>'}`;

  return (
    <div className="panel">
      <div className="label">Memory Query</div>
      <div className="notice-compact skill-notice">
        Recall by wiki tag only — published memory, never raw/ (ADR-0005). This finds pages; it
        does not run Hermes, Claude, Codex, or any Skill (ADR-0001).
      </div>

      <div className="search-box mq-search-box">
        <Search size={11} />
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="Query memory by topic…"
          spellCheck={false}
        />
        {searching && (
          <button className="search-clear" onClick={() => setTopic('')} title="Clear">
            <X size={11} />
          </button>
        )}
      </div>

      {!searching && <div className="placeholder-body">Type a topic to recall matching wiki pages.</div>}

      {searching && result.error && (
        <div className="placeholder-body warn-text">Memory query failed — {result.error}</div>
      )}

      {searching && !result.error && !result.data && <div className="placeholder-body">Searching…</div>}

      {searching && result.data && (
        <>
          <div className="mq-tag-row">
            {result.data.matchedTags.length === 0 ? (
              <span className="dim">No wiki tags match “{result.data.query}”.</span>
            ) : (
              result.data.matchedTags.map((t) => (
                <button
                  key={t.tag}
                  className="chip mq-tag-chip"
                  onClick={() => setTopic(t.tag)}
                  title={`${t.count} page${t.count === 1 ? '' : 's'} carry this tag`}
                >
                  {t.tag} · {t.count}
                </button>
              ))
            )}
          </div>

          {result.data.results.length === 0 ? (
            <div className="placeholder-body">No matching wiki pages.</div>
          ) : (
            result.data.results.map((r) => (
              <div className="skill-card" key={r.path}>
                <div className="skill-head">
                  <span className="skill-name">{r.title || r.path}</span>
                </div>
                {r.summary && <div className="skill-desc">{r.summary}</div>}
                <div className="mq-tag-row">
                  {r.matchedTags.map((tag) => (
                    <span key={tag} className="chip">
                      {tag}
                    </span>
                  ))}
                </div>
                <div className="skill-meta">
                  <button className="doc-link" onClick={() => onOpenDoc(r.path)} title="Open in Documentation">
                    {r.path}
                    <ExternalLink size={10} style={{ verticalAlign: '-1px', marginLeft: 5 }} />
                  </button>
                </div>
              </div>
            ))
          )}
          {result.data.truncated && (
            <div className="doc-rail-empty">More matches truncated — narrow the topic.</div>
          )}
        </>
      )}

      <div className="mq-handoff">
        <div className="wf-summary">Hermes handoff — guided, copy-only</div>
        <div className="notice-compact skill-notice">
          Copy this into Hermes to run full recall + synthesis. The console never executes it
          (ADR-0001).
        </div>
        <CommandPreview command={handoffCommand} />
      </div>
    </div>
  );
}
