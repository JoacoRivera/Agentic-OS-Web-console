import { fmtTs } from '../format.js';

/**
 * Ingest queue: Draft captures not yet ingested, newest first, capped
 * server-side at DRAFT_LIMIT (`drafts[]`); `draftN` counts the whole queue.
 * Memory repo ADR-0002: no triage and no approval — a Draft waits only for
 * /aos-ingest, which flips `Status: Draft` to `Status: Ingested` (legacy
 * `Approved` counts as Ingested). Drafts parked in scripts/capture-holds.txt
 * are on hold, listed apart and never overdue. Promotion to wiki/ is
 * publishing, and raw/ never drains (ADR-0003).
 */
export default function ReviewQueue({ metrics }) {
  const { drafts, draftN, held = [], heldN = 0, ingestedN, captures = {} } = metrics;
  const rows = (items) =>
    items.map((d) => (
      <div key={d.path} className="run">
        <span className="run-time">{fmtTs(d.mtime)}</span>
        <span className="run-name" title={d.reason ? `${d.path} — on hold: ${d.reason}` : d.path}>
          {d.name}
        </span>
        {d.origin === 'bridge' && (
          <span className="chip" title="Written by the Memory Bridge's automatic capture — no user confirmed the result (memory repo ADR-0003)">
            Memory Bridge
          </span>
        )}
        <span className="run-path">{d.path}</span>
      </div>
    ));
  return (
    <div className="panel">
      <div className="label">
        Ingest queue
        <span className={`label-sub${draftN > 0 ? ' warn-text' : ''}`}>
          {draftN} Draft{draftN === 1 ? '' : 's'} waiting · {heldN} on hold · {ingestedN} ingested
        </span>
      </div>
      {draftN === 0 ? (
        <div className="placeholder-body">
          No Draft captures waiting — every capture is ingested or on hold.
        </div>
      ) : (
        rows(drafts)
      )}
      {draftN > drafts.length && (
        <div className="placeholder-body">
          Showing the newest {drafts.length} of {draftN} Drafts.
        </div>
      )}
      {heldN > 0 && (
        <>
          <div className="label">
            On hold
            <span className="label-sub">parked in scripts/capture-holds.txt — not overdue</span>
          </div>
          {rows(held)}
          {heldN > held.length && (
            <div className="placeholder-body">
              Showing the newest {held.length} of {heldN} held Drafts.
            </div>
          )}
        </>
      )}
      {(captures.mismatchN > 0 || captures.layoutWarningN > 0 || captures.holdWarningN > 0) && (
        <div className="placeholder-body warn-text">
          {[
            captures.mismatchN > 0 && `${captures.mismatchN} status mismatch(es) (counted as Ingested)`,
            captures.layoutWarningN > 0 && `${captures.layoutWarningN} Status: marker(s) outside examples/`,
            captures.holdWarningN > 0 && `${captures.holdWarningN} hold-list warning(s)`,
          ]
            .filter(Boolean)
            .join(' · ')}
          {' '}— run <code>/aos-reconcile</code> for the itemized report.
        </div>
      )}
      <div className="notice-compact">
        A capture is ingested in the same session it is written: <code>/aos-ingest</code> flips
        its <code>Status: Draft</code> line to <code>Status: Ingested</code> and makes one local
        commit. There is no triage or approval step; the weekly maintenance pass is the owner&apos;s
        review. Legacy <code>Status: Approved</code> captures count as Ingested.
      </div>
    </div>
  );
}
