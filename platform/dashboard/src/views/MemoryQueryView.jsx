import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Search, X } from 'lucide-react';
import CommandPreview from '../components/CommandPreview.jsx';

const DEBOUNCE_MS = 250;
/** The reference script's default `--top`; the rest is one click away. */
const FIRST_SHOWN = 8;

/**
 * Memory Query section: deterministic recall over the published wiki, in
 * the memory repo's own order (AGENTS.md §Query) — question-first BM25F
 * recall (scripts/wiki_recall.py) first, tag recall (scripts/wiki-tags.py)
 * second. This view only *finds* pages; it never invokes Hermes, Claude,
 * Codex, or any Skill (ADR-0001) — the Hermes handoff below is a copy-only
 * command, never something this console runs. raw/ is never searched here,
 * regardless of EXPOSE_RAW_CONTENT (ADR-0005).
 */
export default function MemoryQueryView({ onOpenDoc }) {
  const [topic, setTopic] = useState('');
  const [includeHistory, setIncludeHistory] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [result, setResult] = useState({ data: null, error: null });
  const requestSequence = useRef(0);

  useEffect(() => {
    const requestId = ++requestSequence.current;
    // Clear any earlier query's results immediately so a stale result never
    // lingers on screen while a new question is pending — the "Searching…"
    // placeholder below only shows when result.data is null.
    setResult({ data: null, error: null });
    setShowAll(false);
    const q = topic.trim();
    if (!q) {
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const url = `/api/memory/query?topic=${encodeURIComponent(q)}${includeHistory ? '&includeHistory=1' : ''}`;
        const res = await fetch(url, { signal: controller.signal });
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
  }, [topic, includeHistory]);

  const searching = topic.trim().length > 0;
  const handoffCommand = `/hermes-aos aos-query-memory ${topic.trim() || '<topic>'}`;
  const data = result.data;
  const shown = data ? (showAll ? data.results : data.results.slice(0, FIRST_SHOWN)) : [];

  return (
    <div className="panel">
      <div className="label">Memory Query</div>
      <div className="notice-compact skill-notice">
        Recall by question (BM25F over title, tags, summary, path and text), then by wiki tag —
        published memory, never raw/ (ADR-0005). Lexical: ask in English with the identifiers you
        expect on the page. This finds pages; it does not run Hermes, Claude, Codex, or any Skill
        (ADR-0001).
      </div>

      <div className="search-box mq-search-box">
        <Search size={11} />
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="Ask memory a question…"
          spellCheck={false}
        />
        {searching && (
          <button className="search-clear" onClick={() => setTopic('')} title="Clear">
            <X size={11} />
          </button>
        )}
      </div>

      <label className="toggle mq-history-toggle">
        <input type="checkbox" checked={includeHistory} onChange={(e) => setIncludeHistory(e.target.checked)} />
        include history (eval results and worked examples at full weight)
      </label>

      {!searching && <div className="placeholder-body">Ask a question to recall matching wiki pages.</div>}

      {searching && result.error && (
        <div className="placeholder-body warn-text">Memory query failed — {result.error}</div>
      )}

      {searching && !result.error && !data && <div className="placeholder-body">Searching…</div>}

      {searching && data && (
        <>
          <div className="wf-summary mq-count">
            {data.pagesMatched} of {data.pagesIndexed} pages share a word with the question
          </div>

          {data.results.length === 0 ? (
            <div className="placeholder-body">
              No page shares a word with the question — rephrase in English, or use the tags below.
            </div>
          ) : (
            shown.map((r) => (
              <div className="skill-card" key={r.path} data-testid="mq-result">
                <div className="skill-head">
                  <span className="skill-name">{r.title || r.path}</span>
                  <span className="mq-score" title="BM25F score">
                    {r.score.toFixed(1)}
                  </span>
                  {r.history && (
                    <span className="chip mq-history-chip" title="Eval result or worked example">
                      history
                    </span>
                  )}
                </div>
                {r.summary && <div className="skill-desc">{r.summary}</div>}
                {r.tags.length > 0 && (
                  <div className="mq-tag-row">
                    {r.tags.map((tag, i) => (
                      <span key={`${tag}-${i}`} className="chip">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                <div className="skill-meta">
                  <button className="doc-link" onClick={() => onOpenDoc(r.path)} title="Open in Documentation">
                    {r.path}
                    <ExternalLink size={10} style={{ verticalAlign: '-1px', marginLeft: 5 }} />
                  </button>
                </div>
              </div>
            ))
          )}
          {!showAll && data.results.length > FIRST_SHOWN && (
            <button className="btn mq-show-all" onClick={() => setShowAll(true)}>
              Show all {data.results.length}
            </button>
          )}
          {data.truncated && (showAll || data.results.length <= FIRST_SHOWN) && (
            <div className="doc-rail-empty">
              {data.pagesMatched - data.results.length} more matches not shown — narrow the question.
            </div>
          )}

          <TagRecall
            key={`${data.query}|${data.results.length === 0}`}
            tagRecall={data.tagRecall}
            query={data.query}
            open={data.results.length === 0}
            onPickTag={setTopic}
            onOpenDoc={onOpenDoc}
          />
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

/** Step 2 — tag recall: collapsed when BM25F found pages, open when it did not. */
function TagRecall({ tagRecall, query, open, onPickTag, onOpenDoc }) {
  return (
    <details className="mq-tag-recall" open={open}>
      <summary className="wf-summary">
        Tag recall · {tagRecall.matchedTags.length} tag{tagRecall.matchedTags.length === 1 ? '' : 's'},{' '}
        {tagRecall.results.length}
        {tagRecall.truncated ? '+' : ''} page{tagRecall.results.length === 1 ? '' : 's'}
      </summary>
      <div className="mq-tag-row">
        {tagRecall.matchedTags.length === 0 ? (
          <span className="dim">No wiki tags match “{query}”.</span>
        ) : (
          tagRecall.matchedTags.map((t) => (
            <button
              key={t.tag}
              className="chip mq-tag-chip"
              onClick={() => onPickTag(t.tag)}
              title={`${t.count} page${t.count === 1 ? '' : 's'} carry this tag`}
            >
              {t.tag} · {t.count}
            </button>
          ))
        )}
      </div>
      {tagRecall.results.map((r) => (
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
      ))}
      {tagRecall.truncated && <div className="doc-rail-empty">More tag matches truncated — narrow the topic.</div>}
    </details>
  );
}
