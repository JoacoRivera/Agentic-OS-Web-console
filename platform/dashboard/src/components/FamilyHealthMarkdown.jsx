import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyButton } from './CopyButton.jsx';

/**
 * Verbatim Markdown from the Family Health record (ADR-0010). Links are
 * rendered inert on purpose: a note links to sibling notes and to original
 * PDF/JPEG documents, and neither the docs explorer nor this section serves
 * those over HTTP. The reader copies the absolute path instead.
 */
function InertLink({ href, children }) {
  return (
    <span className="doc-link-inert" title={href}>
      {children}
    </span>
  );
}

export default function FamilyHealthMarkdown({ file, error, loading }) {
  if (error) {
    return <div className="placeholder-body warn-text">{error}</div>;
  }
  if (loading || !file) {
    return <div className="placeholder-body">{loading ? 'Loading note…' : 'Select an exam note, profile, or timeline.'}</div>;
  }
  return (
    <div>
      <div className="doc-head">
        <span className="doc-path" title={file.path}>{file.path}</span>
        <div className="copy-cluster">
          <CopyButton label="abs path" value={file.absolutePath} />
          <CopyButton label="open cmd" value={`code "${file.absolutePath}"`} />
        </div>
      </div>
      <div className="markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: InertLink }}>
          {file.markdown}
        </ReactMarkdown>
      </div>
    </div>
  );
}
