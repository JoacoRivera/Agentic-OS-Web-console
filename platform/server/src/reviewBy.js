import fs from 'node:fs/promises';
import path from 'node:path';
import { isLogFile } from './captures.js';
import { calendarDay, localIsoDay } from './dates.js';

/**
 * `review-by:` dates — a mirror of the memory repo's wiki-lint check 25
 * (`scripts/aos_wiki/lint.py`, `check_review_by`). A page may carry an inline
 * `review-by: YYYY-MM-DD` token (in practice on a lesson that must be confirmed
 * by a further case). On every `wiki/**` page except the log:
 *
 * - the token after `review-by:` runs up to whitespace or a closing backtick,
 *   with trailing `.,;:)` stripped;
 * - an empty token is a prose mention of the convention and is ignored;
 * - a token that is not a real `YYYY-MM-DD` day is "malformed";
 * - a day on or before today (the local calendar day) is "due";
 * - anything later is "pending".
 *
 * Information only: it never changes a workflow status or the maintenance
 * cadence. When check 25 changes, this module and the independent recount in
 * `scripts/check-metrics-groundtruth.mjs` change with it.
 */

const REVIEW_BY_RE = /review-by:[ \t]*([^\s`]*)/g;
const TRAILING_PUNCT_RE = /[.,;:)]+$/;
// Python's str.splitlines() boundaries, so line numbers match lint's.
const LINE_SPLIT_RE = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
// A malformed token is echoed back (lint prints it too); bound its length.
const VALUE_MAX = 40;

export const REVIEW_BY_ITEM_LIMIT = 20;

/** Every `review-by:` token in `text` → `[{line, date, state}]`, in reading order. */
export function scanReviewBy(text, todayIso) {
  const found = [];
  const lines = (text || '').split(LINE_SPLIT_RE);
  if (lines.length > 0 && lines.at(-1) === '') lines.pop();
  lines.forEach((lineText, i) => {
    for (const match of lineText.matchAll(REVIEW_BY_RE)) {
      const value = match[1].replace(TRAILING_PUNCT_RE, '');
      if (!value) continue;
      const day = calendarDay(value);
      const state = day === null ? 'malformed' : day <= todayIso ? 'due' : 'pending';
      found.push({ line: i + 1, date: value.slice(0, VALUE_MAX), state });
    }
  });
  return found;
}

const STATE_ORDER = { due: 0, malformed: 1 };

/**
 * Wiki-wide recount over `wikiPaths` (repo-relative, `wiki/…`). Log files are
 * history, never due. `items` lists the due and malformed entries — due first,
 * then by date, path and line — capped at REVIEW_BY_ITEM_LIMIT; the counters
 * stay exact. `nextDue` is the earliest pending day.
 */
export async function collectReviewBy(repoRoot, wikiPaths, now = new Date()) {
  const today = localIsoDay(now);
  const all = [];
  await Promise.all(
    wikiPaths
      .filter((relPath) => relPath.endsWith('.md') && !isLogFile(relPath))
      .map(async (relPath) => {
        let text;
        try {
          text = await fs.readFile(path.join(repoRoot, relPath), 'utf8');
        } catch {
          return; // vanished between walk and read — nothing to report
        }
        for (const hit of scanReviewBy(text, today)) all.push({ path: relPath, ...hit });
      })
  );
  const count = (state) => all.filter((hit) => hit.state === state).length;
  const pending = all.filter((hit) => hit.state === 'pending').map((hit) => hit.date).sort();
  const items = all
    .filter((hit) => hit.state !== 'pending')
    .sort(
      (a, b) =>
        STATE_ORDER[a.state] - STATE_ORDER[b.state]
        || a.date.localeCompare(b.date)
        || a.path.localeCompare(b.path)
        || a.line - b.line
    )
    .slice(0, REVIEW_BY_ITEM_LIMIT);
  return {
    dueN: count('due'),
    malformedN: count('malformed'),
    pendingN: pending.length,
    nextDue: pending[0] ?? null,
    items,
  };
}
