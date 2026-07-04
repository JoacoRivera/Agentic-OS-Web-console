import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import DocsExplorer from '../components/DocsExplorer.jsx';
import MarkdownViewer, { scrollToFragment } from '../components/MarkdownViewer.jsx';
import { buildDocIndex } from '../doclinks.js';

/** Search results list: filename hits + content hits with line snippets. */
function SearchResults({ search, onSelect }) {
  if (search.error) {
    return <div className="placeholder-body warn-text">Search failed — {search.error}</div>;
  }
  if (!search.data) {
    return <div className="placeholder-body">Searching…</div>;
  }
  const { results, truncated } = search.data;
  if (results.length === 0) {
    return <div className="placeholder-body">No matches.</div>;
  }
  return (
    <div className="search-results">
      {results.map((r) => (
        <button key={r.path} className="search-hit" onClick={() => onSelect(r.path)} title={r.path}>
          <div className="search-hit-head">
            <span className={`badge kind-${r.source}`}>{r.source}</span>
            <span className="search-hit-path">{r.path}</span>
          </div>
          {r.snippets.map((s) => (
            <div key={s.line} className="search-snippet">
              <span className="search-line">{s.line}</span> {s.text}
            </div>
          ))}
        </button>
      ))}
      {truncated && <div className="doc-rail-empty">More matches truncated — narrow the query.</div>}
    </div>
  );
}

/**
 * Documentation section: tree/search (left) + viewer with TOC & backlinks
 * (right). Live reads — the tree refreshes on mount; doc, backlinks, and
 * search results are fetched per interaction.
 */
export default function DocsView({ refreshKey = 0 }) {
  const [tree, setTree] = useState(null);
  const [treeError, setTreeError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [doc, setDoc] = useState(null);
  const [docError, setDocError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [backlinks, setBacklinks] = useState(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState({ data: null, error: null });
  const pendingFragment = useRef(null);

  const docIndex = useMemo(() => buildDocIndex(tree), [tree]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/docs/tree');
        if (cancelled) return;
        if (res.ok) {
          setTree(await res.json());
          setTreeError(null);
        } else {
          const body = await res.json().catch(() => ({}));
          setTreeError(body.message || `HTTP ${res.status}`);
        }
      } catch (err) {
        if (!cancelled) setTreeError(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    if (!selected) return undefined;
    let cancelled = false;
    setLoading(true);
    setBacklinks(null);
    (async () => {
      try {
        const [docRes, blRes] = await Promise.all([
          fetch(`/api/docs/file?path=${encodeURIComponent(selected)}`),
          fetch(`/api/docs/backlinks?path=${encodeURIComponent(selected)}`),
        ]);
        if (cancelled) return;
        if (docRes.ok) {
          setDoc(await docRes.json());
          setDocError(null);
        } else {
          const body = await docRes.json().catch(() => ({}));
          setDoc(null);
          setDocError({ status: docRes.status, message: body.message || `HTTP ${docRes.status}` });
        }
        setBacklinks(blRes.ok ? (await blRes.json()).backlinks : []);
      } catch (err) {
        if (!cancelled) {
          setDoc(null);
          setDocError({ status: 0, message: err.message });
          setBacklinks([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, refreshKey]);

  // Scroll to a #heading fragment once the navigated-to doc has rendered.
  useEffect(() => {
    if (!doc || !pendingFragment.current) return;
    scrollToFragment(pendingFragment.current);
    pendingFragment.current = null;
  }, [doc]);

  // Debounced live search; empty query returns to the tree.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearch({ data: null, error: null });
      return undefined;
    }
    let cancelled = false;
    setSearch({ data: null, error: null });
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/docs/search?q=${encodeURIComponent(q)}`);
        if (cancelled) return;
        if (res.ok) {
          setSearch({ data: await res.json(), error: null });
        } else {
          const body = await res.json().catch(() => ({}));
          setSearch({ data: null, error: body.message || `HTTP ${res.status}` });
        }
      } catch (err) {
        if (!cancelled) setSearch({ data: null, error: err.message });
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, refreshKey]);

  const navigate = (path, fragment) => {
    pendingFragment.current = fragment ?? null;
    if (path === selected) {
      scrollToFragment(fragment);
      pendingFragment.current = null;
    } else {
      setSelected(path);
    }
  };

  const searching = query.trim().length > 0;
  return (
    <div className="docs-layout">
      <div className="panel docs-tree-panel">
        <div className="label">Documentation</div>
        <div className="search-box">
          <Search size={11} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search docs…"
            spellCheck={false}
          />
          {searching && (
            <button className="search-clear" onClick={() => setQuery('')} title="Clear search">
              <X size={11} />
            </button>
          )}
        </div>
        {searching ? (
          <SearchResults search={search} onSelect={(path) => navigate(path)} />
        ) : tree ? (
          <DocsExplorer tree={tree} selected={selected} onSelect={(path) => navigate(path)} />
        ) : (
          <div className="placeholder-body">
            {treeError ? `Docs tree unavailable — ${treeError}` : 'Loading docs tree…'}
          </div>
        )}
      </div>
      <div className="panel docs-viewer-panel">
        <MarkdownViewer
          doc={doc}
          error={docError}
          loading={loading}
          docIndex={docIndex}
          backlinks={backlinks}
          onNavigate={navigate}
        />
      </div>
    </div>
  );
}
