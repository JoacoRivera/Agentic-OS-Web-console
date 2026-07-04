import { useEffect, useState } from 'react';
import DocsExplorer from '../components/DocsExplorer.jsx';
import MarkdownViewer from '../components/MarkdownViewer.jsx';

/**
 * Documentation section: tree (left) + viewer (right). Live reads — the
 * tree refreshes on mount; a doc is fetched on every selection.
 */
export default function DocsView() {
  const [tree, setTree] = useState(null);
  const [treeError, setTreeError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [doc, setDoc] = useState(null);
  const [docError, setDocError] = useState(null);
  const [loading, setLoading] = useState(false);

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
  }, []);

  useEffect(() => {
    if (!selected) return undefined;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/docs/file?path=${encodeURIComponent(selected)}`);
        if (cancelled) return;
        if (res.ok) {
          setDoc(await res.json());
          setDocError(null);
        } else {
          const body = await res.json().catch(() => ({}));
          setDoc(null);
          setDocError({ status: res.status, message: body.message || `HTTP ${res.status}` });
        }
      } catch (err) {
        if (!cancelled) {
          setDoc(null);
          setDocError({ status: 0, message: err.message });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  return (
    <div className="docs-layout">
      <div className="panel docs-tree-panel">
        <div className="label">Documentation</div>
        {tree ? (
          <DocsExplorer tree={tree} selected={selected} onSelect={setSelected} />
        ) : (
          <div className="placeholder-body">
            {treeError ? `Docs tree unavailable — ${treeError}` : 'Loading docs tree…'}
          </div>
        )}
      </div>
      <div className="panel docs-viewer-panel">
        <MarkdownViewer doc={doc} error={docError} loading={loading} />
      </div>
    </div>
  );
}
