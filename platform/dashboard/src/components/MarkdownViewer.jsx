import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CornerDownLeft, EyeOff, List } from 'lucide-react';
import CopyButtons from './CopyButton.jsx';
import {
  remarkWikilinks,
  resolveDocHref,
  slugify,
  headingText,
  extractToc,
} from '../doclinks.js';

/** Scroll a heading (by fragment) into view inside the rendered doc. */
export function scrollToFragment(fragment) {
  if (!fragment) return;
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    /* malformed escape — use as-is */
  }
  document.getElementById(`doc-h-${slugify(decoded)}`)?.scrollIntoView({ block: 'start' });
}

function DocLink({ href, children, currentPath, docIndex, onNavigate }) {
  const resolved = resolveDocHref(href, currentPath, docIndex);
  if (resolved.kind === 'external') {
    return (
      <a href={resolved.href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  }
  if (resolved.kind === 'anchor') {
    return (
      <a
        href={`#${resolved.fragment}`}
        onClick={(e) => {
          e.preventDefault();
          scrollToFragment(resolved.fragment);
        }}
      >
        {children}
      </a>
    );
  }
  if (resolved.kind === 'internal') {
    return (
      <a
        className="doc-link-internal"
        href={`#${resolved.path}`}
        onClick={(e) => {
          e.preventDefault();
          onNavigate(resolved.path, resolved.fragment);
        }}
      >
        {children}
      </a>
    );
  }
  return (
    <span className="doc-link-inert" title={`unresolved: ${href}`}>
      {children}
    </span>
  );
}

const heading = (Tag) =>
  function Heading({ children }) {
    return <Tag id={`doc-h-${slugify(headingText(children))}`}>{children}</Tag>;
  };

/**
 * Renders one doc: source badge + copy cluster + frontmatter + GFM markdown,
 * with a right-side rail (table of contents + backlinks). The custom `a`
 * renderer rewrites internal links (relative, root-relative, wikilink,
 * heading anchor) to in-console navigation; external links open in a new
 * tab; unresolved targets render disabled. Raw-hidden (403) renders the
 * ADR-0005 notice, not an error.
 */
export default function MarkdownViewer({ doc, error, loading, docIndex, backlinks, onNavigate }) {
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
  const toc = extractToc(doc.markdown);

  return (
    <div className="doc-view">
      <div className="doc-head">
        <span className={`badge kind-${doc.source}`}>{doc.source}</span>
        <span className="doc-path" title={doc.absolutePath}>
          {doc.path}
        </span>
        <CopyButtons relPath={doc.path} absPath={doc.absolutePath} />
      </div>
      <div className="doc-columns">
        <div className="doc-main">
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
              remarkPlugins={[remarkGfm, remarkWikilinks]}
              components={{
                h1: heading('h1'),
                h2: heading('h2'),
                h3: heading('h3'),
                h4: heading('h4'),
                a: ({ href, children }) => (
                  <DocLink
                    href={href}
                    currentPath={doc.path}
                    docIndex={docIndex}
                    onNavigate={onNavigate}
                  >
                    {children}
                  </DocLink>
                ),
              }}
            >
              {doc.markdown}
            </ReactMarkdown>
          </div>
        </div>
        <div className="doc-rail">
          {toc.length > 0 && (
            <div className="doc-rail-section">
              <div className="label">
                <List size={10} style={{ marginRight: 5, verticalAlign: -1 }} />
                Contents
              </div>
              {toc.map((h, i) => (
                <button
                  key={`${h.slug}-${i}`}
                  className="doc-rail-row"
                  style={{ paddingLeft: (h.depth - 1) * 10 }}
                  onClick={() => scrollToFragment(h.slug)}
                  title={h.text}
                >
                  {h.text}
                </button>
              ))}
            </div>
          )}
          <div className="doc-rail-section">
            <div className="label">
              <CornerDownLeft size={10} style={{ marginRight: 5, verticalAlign: -1 }} />
              Backlinks
            </div>
            {backlinks == null ? (
              <div className="doc-rail-empty">Loading…</div>
            ) : backlinks.length === 0 ? (
              <div className="doc-rail-empty">No docs link here.</div>
            ) : (
              backlinks.map((b) => (
                <button
                  key={b.path}
                  className="doc-rail-row doc-backlink"
                  onClick={() => onNavigate(b.path)}
                  title={b.path}
                >
                  <span className={`badge kind-${b.source}`}>{b.source}</span>
                  <span className="doc-rail-name">
                    {b.name}
                    {b.count > 1 ? ` ×${b.count}` : ''}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
