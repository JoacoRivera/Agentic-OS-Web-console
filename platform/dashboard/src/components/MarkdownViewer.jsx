import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { EyeOff } from 'lucide-react';

/**
 * Renders one doc: source badge + frontmatter + GFM markdown (headings,
 * code, lists, tables). Raw-hidden (403) renders the ADR-0005 notice, not
 * an error. Internal link rewriting/backlinks arrive with slice #9 — for
 * now external links open in a new tab and relative links are inert.
 */
export default function MarkdownViewer({ doc, error, loading }) {
  if (loading) {
    return <div className="placeholder-body">Loading doc…</div>;
  }
  if (error?.status === 403) {
    return (
      <div className="notice">
        <EyeOff size={14} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>
          Raw content is hidden by default — <code>raw/</code> is the candid, unreviewed tier.
          Start the server with <code>EXPOSE_RAW_CONTENT=true</code> to read raw bodies here.
          Raw metrics are unaffected (ADR-0005).
        </span>
      </div>
    );
  }
  if (error) {
    return <div className="placeholder-body warn-text">Doc unavailable — {error.message}</div>;
  }
  if (!doc) {
    return <div className="placeholder-body">Select a doc from the tree.</div>;
  }

  const fmEntries = Object.entries(doc.frontmatter ?? {});
  return (
    <div className="doc-view">
      <div className="doc-head">
        <span className={`badge kind-${doc.source}`}>{doc.source}</span>
        <span className="doc-path" title={doc.absolutePath}>
          {doc.path}
        </span>
      </div>
      {fmEntries.length > 0 && (
        <div className="doc-frontmatter">
          {fmEntries.map(([key, value]) => (
            <div key={key} className="doc-fm-row">
              <span className="doc-fm-key">{key}</span>
              <span className="doc-fm-value">
                {Array.isArray(value)
                  ? value.join(', ')
                  : typeof value === 'object' && value !== null
                    ? JSON.stringify(value)
                    : String(value)}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children }) =>
              /^https?:\/\//.test(href ?? '') ? (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              ) : (
                <span className="doc-link-inert" title={href}>
                  {children}
                </span>
              ),
          }}
        >
          {doc.markdown}
        </ReactMarkdown>
      </div>
    </div>
  );
}
