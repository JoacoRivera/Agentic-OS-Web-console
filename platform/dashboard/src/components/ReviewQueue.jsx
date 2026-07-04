import { fmtTs } from '../format.js';

/**
 * Unapproved draft captures, newest first, capped server-side at
 * DRAFT_LIMIT (`drafts[]`); `draftN` counts the whole queue. A draft
 * drains only when its `Status:` line is edited to Approved inside the
 * raw file — promotion to wiki/ is publishing, not approval, and raw is
 * append-only (ADR-0003). No raw→wiki funnel framing.
 */
export default function ReviewQueue({ metrics }) {
  const { drafts, draftN } = metrics;
  return (
    <div className="panel">
      <div className="label">
        Review queue
        <span className={`label-sub${draftN > 0 ? ' warn-text' : ''}`}>
          {draftN} unapproved draft{draftN === 1 ? '' : 's'}
        </span>
      </div>
      {draftN === 0 ? (
        <div className="placeholder-body">
          No unapproved draft captures — the review queue is clear.
        </div>
      ) : (
        drafts.map((d) => (
          <div key={d.path} className="run">
            <span className="run-time">{fmtTs(d.mtime)}</span>
            <span className="run-name" title={d.path}>{d.name}</span>
            <span className="run-path">{d.path}</span>
          </div>
        ))
      )}
      {draftN > drafts.length && (
        <div className="placeholder-body">
          Showing the newest {drafts.length} of {draftN} drafts.
        </div>
      )}
      <div className="notice-compact">
        A draft leaves this queue only when its <code>Status:</code> line is edited to
        Approved inside the raw capture file. Promoting a capture to wiki/ is publishing,
        not approval — raw/ is append-only and never drains.
      </div>
    </div>
  );
}
