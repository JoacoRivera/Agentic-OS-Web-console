import { MAINTENANCE_DUE_DAYS, RAW_PATH_RE, isMaintenancePass } from './captures.js';

/**
 * Memory-flow stats (ADR-0003 amendment, 2026-11-14), mirrored from the memory
 * repo's `scripts/memory-stats.py` the way `captures.js` mirrors its capture
 * inventory: capture → ingest latency, maintenance-pass gaps, Ingest queue and
 * on-hold ages, and monthly capture / ingest-entry counts.
 *
 * Dates are explicit lineage only — never Git, a file time or a file name. A
 * capture without a valid intake date is counted as unlineaged and left out of
 * every dated figure; a summary with no values reports `null` figures, never 0.
 * The result holds counts, days and dates only: no raw paths, no body text.
 * When `memory-stats.py` changes, this file and the `check:metrics-groundtruth`
 * recount change with it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** memory-stats.py LATENCY_BUCKETS: [lo, hi (inclusive, null = open), label]. */
export const LATENCY_BUCKETS = Object.freeze([
  [0, 0, 'same day'],
  [1, 3, '1-3d'],
  [4, 7, '4-7d'],
  [8, 30, '8-30d'],
  [31, null, '>30d'],
]);

// aos_wiki/frontmatter.py. Python's `re.M` `^` matches only after `\n`, JS's `m`
// flag also after the Unicode line/paragraph separators, so the line start is
// spelled out instead. Python's `\s` on str is `str.isspace()`: JS's `\s` minus
// U+FEFF, plus \x1c-\x1f and \x85 — spelled out the way `captures.js`
// LINE_SPLIT_RE spells out `str.splitlines()`.
const PY_SPACE = String.raw`\t\n\v\f\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
const lineageRe = (key) => new RegExp(String.raw`(?:^|(?<=\n))${key}[${PY_SPACE}]*:[${PY_SPACE}]*([^${PY_SPACE}]+)`);
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
const SOURCE_ID_RE = lineageRe('source_id');
const INTAKE_RE = lineageRe('knowledge_intake_date');
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A `YYYY-MM-DD` that `date.fromisoformat` accepts: ASCII digits, year
 * 0001-9999, a real Gregorian day. Calendar arithmetic only — `Date.UTC`
 * would map years 0-99 onto 1900-1999.
 */
function realDay(text) {
  if (!ISO_DATE.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const length = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d <= length;
}
// Lowercase only, as frontmatter.CANONICAL_UUID (the growth chart accepts any case).
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const stripQuotes = (value) => value.replace(/^["']+|["']+$/g, ''); // str.strip("\"'")

/**
 * The capture's knowledge intake day (`YYYY-MM-DD`), or null when its lineage
 * is not complete and valid — memory-stats.py `intake_date()`: both fields
 * present on their own line (first non-space token, quotes stripped), a
 * lowercase canonical UUID `source_id`, a real calendar day `<= today`.
 * `text` is newline-normalized (as `classifyCaptures` reads it).
 */
export function captureIntakeDay(text, today) {
  const block = (text ?? '').match(FRONTMATTER_RE);
  if (!block) return null;
  const sid = block[1].match(SOURCE_ID_RE);
  const intake = block[1].match(INTAKE_RE);
  if (!sid || !intake) return null;
  if (!CANONICAL_UUID.test(stripQuotes(sid[1]))) return null;
  const day = stripQuotes(intake[1]);
  if (!realDay(day)) return null;
  return day <= today ? day : null;
}

/** Days since 0001-01-01 (proleptic Gregorian), so years 1-99 stay exact. */
function dayNumber(day) {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  return Math.round(date.getTime() / DAY_MS);
}

/** Whole days from `from` to `to` (both real `YYYY-MM-DD` days). */
const daysBetween = (from, to) => dayNumber(to) - dayNumber(from);

/**
 * memory-stats.py `summarize()`: n, min, median (statistics.median — the mean
 * of the two middle values for an even n), nearest-rank p90, max. Empty →
 * `n: 0` with null figures (absent, never zero).
 */
export function summarize(values) {
  if (values.length === 0) return { n: 0, min: null, median: null, p90: null, max: null };
  const ordered = [...values].sort((a, b) => a - b);
  const n = ordered.length;
  const mid = Math.floor(n / 2);
  const median = n % 2 === 1 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
  const k = Math.max(1, Math.ceil((n * 90) / 100));
  return { n, min: ordered[0], median, p90: ordered[k - 1], max: ordered[n - 1] };
}

/**
 * memory-stats.py `collect()` over what `/api/metrics` already has in hand.
 *
 * @param buckets `classifyCaptures().buckets`
 * @param texts   `classifyCaptures().texts` (path → normalized capture text)
 * @param entries `readLogEntries()` output
 * @param today   the local calendar day, `YYYY-MM-DD`
 */
export function computeFlow({ buckets, texts, entries, today }) {
  // Dated entries only (wiki_log `entry.date is None` → skipped).
  const dated = entries.filter((e) => realDay(e.dateText));

  // First ingest = the earliest *date* over dated ingest entries naming the path.
  const firstIngest = new Map();
  for (const e of dated) {
    if (e.op !== 'ingest') continue;
    for (const line of e.lines) {
      for (const m of line.matchAll(RAW_PATH_RE)) {
        const prev = firstIngest.get(m[0]);
        if (prev === undefined || e.dateText < prev) firstIngest.set(m[0], e.dateText);
      }
    }
  }

  const captures = [];
  for (const [state, items] of [
    ['ingested', buckets.ingested],
    ['onHold', buckets.onHold],
    ['draft', buckets.draft],
  ]) {
    for (const item of items) {
      captures.push({
        state,
        intake: captureIntakeDay(texts.get(item.path), today),
        ingest: firstIngest.get(item.path) ?? null,
      });
    }
  }

  const months = new Map();
  const month = (key) => {
    if (!months.has(key)) months.set(key, { month: key, captures: 0, ingestEntries: 0 });
    return months.get(key);
  };
  for (const c of captures) if (c.intake) month(c.intake.slice(0, 7)).captures++;
  for (const e of dated) if (e.op === 'ingest') month(e.dateText.slice(0, 7)).ingestEntries++;

  const latencies = [];
  let negative = 0;
  let undated = 0;
  for (const c of captures) {
    if (c.state !== 'ingested' || c.intake === null) continue;
    if (c.ingest === null) {
      undated++;
      continue;
    }
    const days = daysBetween(c.intake, c.ingest);
    if (days < 0) negative++;
    else latencies.push(days);
  }

  const passDays = [...new Set(dated.filter(isMaintenancePass).map((e) => e.dateText))].sort();
  const gaps = passDays.slice(1).map((to, i) => ({ from: passDays[i], to, days: daysBetween(passDays[i], to) }));
  const gapDays = gaps.map((g) => g.days);
  // max() keeps the first of equal maxima.
  const longestGap = gaps.reduce((best, g) => (best === null || g.days > best.days ? g : best), null);
  const newest = passDays.at(-1) ?? null;

  const queue = {};
  for (const state of ['draft', 'onHold']) {
    const items = captures.filter((c) => c.state === state);
    const ages = items.filter((c) => c.intake).map((c) => daysBetween(c.intake, today));
    queue[state] = { count: items.length, unlineaged: items.length - ages.length, ages: summarize(ages) };
  }

  return {
    today,
    captures: {
      total: captures.length,
      unlineaged: captures.filter((c) => c.intake === null).length,
    },
    months: [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1)),
    latency: {
      ...summarize(latencies),
      buckets: LATENCY_BUCKETS.map(([lo, hi, label]) => ({
        label,
        count: latencies.filter((d) => d >= lo && (hi === null || d <= hi)).length,
      })),
      noDatedIngestEntry: undated,
      ingestBeforeIntake: negative,
    },
    passes: {
      days: passDays.length,
      newest,
      openGapDays: newest === null ? null : daysBetween(newest, today),
      gaps: summarize(gapDays),
      gapsOverCadence: gapDays.filter((d) => d > MAINTENANCE_DUE_DAYS).length,
      cadenceDays: MAINTENANCE_DUE_DAYS,
      longestGap,
    },
    queue,
  };
}
