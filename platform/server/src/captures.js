import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';

/**
 * Capture lifecycle and activity-log rules, mirrored from the memory repo's
 * own deterministic tooling so the console and `/aos-reconcile` /
 * `scripts/aos_status.py` can never disagree about the same tree:
 *
 * - `scripts/aos_wiki/inventory.py` — which raw files are captures, their
 *   `Status:` state, ingestion evidence and the hold list.
 * - `scripts/wiki_log.py` — where the log lives (`wiki/log.md` plus the
 *   monthly archive `wiki/log/YYYY-MM.md`) and the maintenance-pass rule.
 *
 * The memory repo's ADR-0002 (2026-11-07) retired triage, risk classes and the
 * approval flip: a capture is **Draft** (written, not yet ingested) or
 * **Ingested**; `Status: Approved` is the legacy spelling of Ingested. A Draft
 * named in `scripts/capture-holds.txt` is **on hold** — parked on purpose, not
 * overdue. The weekly **maintenance pass** (`lint | maintenance pass` log
 * entry) is the owner's touchpoint and the only entry that resets the 7-day
 * timer. Everything here is read-only and computes on demand.
 *
 * A capture's **origin** (`bridge` | `other`) is a read-only attribute, never a
 * state: `bridge` mirrors `scripts/aos_memory.py` `_BRIDGE_SOURCE` (memory repo
 * ADR-0003, the Memory Bridge's automatic-capture `Source:` line).
 */

export const HOLDS_FILE = 'scripts/capture-holds.txt';
export const MAINTENANCE_DUE_DAYS = 7; // wiki_log.MAINTENANCE_CADENCE_DAYS
export const MAINTENANCE_OVERDUE_DAYS = 10; // aos_status.OVERDUE_DAYS

const INGESTED_SPELLINGS = new Set(['Ingested', 'Approved']);
const CANONICAL_STATUSES = new Set(['Draft', ...INGESTED_SPELLINGS]);
const TEMPLATE_DIRS = new Set(['template', 'templates']);

// Python reads every file with universal newlines; normalize the same way so
// a CRLF capture or log reads exactly as it does to the inventory.
const normalize = (text) => (text ?? '').replace(/\r\n?/g, '\n');
// str.splitlines() boundaries other than \r (already normalized away).
const LINE_SPLIT_RE = /\n|[\v\f\x1c-\x1e\x85\u2028\u2029]/;

async function readText(abs) {
  return normalize(await fs.readFile(abs, 'utf8'));
}

// ---------- the activity log (wiki_log.py) ----------

const ARCHIVE_NAME_RE = /^(\d{4})-(\d{2})\.md$/;
const HEADING_RE = /^## \[(\d{4}-\d{2}-\d{2})\] (\S+) \| (.+)$/;
// `maintenance pass`, then the end or a separator; `maintenance passes` does not count.
const MAINTENANCE_SUBJECT_RE = /^maintenance pass(?:$|[\s:;,(—–-])/;

/** True for `wiki/log.md` and every file directly inside the `wiki/log/` archive. */
export function isLogFile(relPath) {
  const parts = relPath.split('/');
  return (
    (parts.length === 2 && parts[0] === 'wiki' && parts[1] === 'log.md')
    || (parts.length === 3 && parts[0] === 'wiki' && parts[1] === 'log')
  );
}

/** A real ISO calendar day (what `date.fromisoformat` accepts for this shape). */
function validDay(text) {
  const [y, m, d] = text.split('-').map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}

/** `wiki/log.md` followed by the archive, newest month first (malformed names last). */
async function logFiles(repoRoot) {
  const files = [];
  try {
    if ((await fs.stat(path.join(repoRoot, 'wiki/log.md'))).isFile()) files.push('wiki/log.md');
  } catch {
    /* no log.md */
  }
  let archive = [];
  try {
    archive = (await fs.readdir(path.join(repoRoot, 'wiki/log'), { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name);
  } catch {
    /* no archive */
  }
  archive.sort((a, b) => {
    const ka = ARCHIVE_NAME_RE.test(a);
    const kb = ARCHIVE_NAME_RE.test(b);
    if (ka !== kb) return ka ? -1 : 1; // well-formed names first (reverse of False<True)
    return a < b ? 1 : a > b ? -1 : 0; // then name descending
  });
  return [...files, ...archive.map((name) => `wiki/log/${name}`)];
}

/**
 * Every well-formed `## [date] op | subject` entry across the log and its
 * archive, newest first (`index` 0 = newest). A `## ` line that is not a valid
 * heading ends the current entry and starts none.
 */
export async function readLogEntries(repoRoot) {
  const out = [];
  for (const file of await logFiles(repoRoot)) {
    let text;
    try {
      text = await readText(path.join(repoRoot, file));
    } catch {
      continue;
    }
    let current = null;
    for (const line of text.split(LINE_SPLIT_RE)) {
      if (line.startsWith('## ')) {
        const m = line.match(HEADING_RE);
        current = null;
        if (m) {
          current = {
            index: out.length,
            file,
            dateText: m[1],
            op: m[2],
            subject: m[3],
            lines: [line],
          };
          out.push(current);
        }
      } else if (current) {
        current.lines.push(line);
      }
    }
  }
  return out;
}

export function isMaintenancePass(entry) {
  return entry.op === 'lint' && MAINTENANCE_SUBJECT_RE.test(entry.subject);
}

/** The newest maintenance-pass entry with a valid date, or null. */
export function lastMaintenancePass(entries) {
  return entries.find((e) => isMaintenancePass(e) && validDay(e.dateText)) ?? null;
}

// ---------- captures (aos_wiki/inventory.py) ----------

const STATUS_RE = /^Status:(.*)$/gm;
// A raw/ path with allowlisted boundaries on both sides (see inventory.py:
// a denylist admits `raw/t/a.md.bak` as proof for `raw/t/a.md`). `\w` is
// Python's Unicode word class: letters, numbers, underscore.
export const RAW_PATH_RE =
  /(?:^|(?<=[\s(\[`"',])|(?<=\.\.\/)|(?<=\.\/))raw\/[\p{L}\p{N}_./-]+?\.md(?:(?=[\s)\]`"',;:])|(?=\.(?:\s|$))|(?=$))/gmu;

/** Template scope test on repo-relative parts only. */
export function isTemplatePath(relPath) {
  const parts = relPath.split('/');
  const name = parts[parts.length - 1];
  if (name === '_template.md' || name.endsWith('-template.md')) return true;
  return parts.slice(0, -1).some((part) => TEMPLATE_DIRS.has(part.toLowerCase()));
}

/**
 * The literal `Status:` value — 'Draft', 'Ingested', 'Approved', or 'none'.
 * Exactly one canonical inline marker counts; zero, several, or a
 * non-canonical value read as 'none' (the Draft side, never upgraded).
 */
export function readStatus(text) {
  const found = [...normalize(text).matchAll(STATUS_RE)];
  if (found.length !== 1) return 'none';
  const value = found[0][1].trim();
  return CANONICAL_STATUSES.has(value) ? value : 'none';
}

/** `{holds: Map<raw path, reason>, warnings: string[]}`; a missing file means no holds. */
export async function readHolds(repoRoot) {
  const holds = new Map();
  const warnings = [];
  let text;
  try {
    text = await readText(path.join(repoRoot, HOLDS_FILE));
  } catch {
    return { holds, warnings };
  }
  text.split(LINE_SPLIT_RE).forEach((line, i) => {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith('#')) return;
    const hash = stripped.indexOf('#');
    const entry = (hash === -1 ? stripped : stripped.slice(0, hash)).trim();
    const reason = hash === -1 ? '' : stripped.slice(hash + 1).trim();
    if (entry.includes(' ') || !entry.startsWith('raw/') || !entry.endsWith('.md')) {
      warnings.push(`${HOLDS_FILE}:${i + 1}: not a raw/...md path`);
      return;
    }
    holds.set(entry, reason);
  });
  return { holds, warnings };
}

const FRONTMATTER_BLOCK_RE = /^---\n([\s\S]*?)\n---/;
const SOURCE_KEY_RE = /^source[ \t]*:/gm;
const parseYaml = matter.engines.yaml.parse;

/**
 * The raw/ paths a frontmatter block declares under `source:` (frontmatter.py
 * `sources`). null = unusable (invalid YAML, a repeated `source:` key, a
 * non-string item) — never treated as evidence.
 */
export function declaredSourcePaths(fm) {
  let data;
  try {
    // `json: true` lets duplicate keys through (last wins, as PyYAML); a
    // repeated `source:` key is rejected explicitly below, like _field_nodes.
    data = parseYaml(fm, { json: true });
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  if ((fm.match(SOURCE_KEY_RE) ?? []).length > 1) return null;
  const value = data.source;
  let values;
  if (typeof value === 'string') values = [value];
  else if (Array.isArray(value)) {
    if (!value.every((v) => typeof v === 'string')) return null;
    values = value;
  } else if (value === null || value === undefined) return [];
  else return null;
  return values.filter((v) => v.startsWith('raw/'));
}

/** Every raw/ path named by a wiki page's frontmatter `source:` list. */
async function declaredSources(repoRoot, wikiPaths) {
  const declared = new Set();
  await Promise.all(
    wikiPaths.map(async (rel) => {
      let text;
      try {
        text = await readText(path.join(repoRoot, rel));
      } catch {
        return;
      }
      const m = text.match(FRONTMATTER_BLOCK_RE);
      if (!m) return;
      for (const p of declaredSourcePaths(m[1]) ?? []) declared.add(p);
    })
  );
  return declared;
}

/** `Map<raw path, index of its oldest ingest entry>` (index 0 = newest). */
function ingestLogIndex(entries) {
  const first = new Map();
  for (const entry of entries) {
    if (entry.op !== 'ingest') continue;
    for (const line of entry.lines) {
      for (const m of line.matchAll(RAW_PATH_RE)) first.set(m[0], entry.index);
    }
  }
  return first;
}

// scripts/aos_memory.py:697 `_BRIDGE_SOURCE`. If the memory repo rewords it,
// change it here and in check-metrics-groundtruth.mjs (hardcoded twice on purpose).
export const BRIDGE_SOURCE = 'Agentic OS Memory Bridge automatic capture';

/**
 * 'bridge' when a header line starts with the unqualified `Source:` marker and
 * names BRIDGE_SOURCE (the ADR's "a `Source:` line naming …"); otherwise
 * 'other'. The header is every line before the first line starting with `## `
 * (the bridge writes it above `## Task`, aos_memory.py:1889-1898); a file with
 * no such heading is all header. Narrower than the doctor's whole-text
 * substring, so a capture that only discusses or quotes the bridge in its body
 * is not flagged. `other` never means user-approved — the console does not
 * guess about legacy `Source:` shapes.
 */
export function captureOrigin(text) {
  for (const line of normalize(text).split(LINE_SPLIT_RE)) {
    if (line.startsWith('## ')) break;
    if (line.startsWith('Source:') && line.includes(BRIDGE_SOURCE)) return 'bridge';
  }
  return 'other';
}

/**
 * Classify every in-scope capture into the inventory's buckets.
 *
 * @param rawPaths  every repo-relative `raw/**.md` path
 * @param wikiPaths every repo-relative `wiki/**.md` path
 * @param entries   `readLogEntries()` output
 */
export async function classifyCaptures(repoRoot, rawPaths, wikiPaths, entries) {
  const declared = await declaredSources(repoRoot, wikiPaths);
  const firstIngest = ingestLogIndex(entries);
  const { holds, warnings: holdWarnings } = await readHolds(repoRoot);

  const texts = new Map();
  await Promise.all(
    rawPaths.filter((p) => !isTemplatePath(p)).map(async (rel) => {
      try {
        texts.set(rel, await readText(path.join(repoRoot, rel)));
      } catch {
        texts.set(rel, '');
      }
    })
  );

  const buckets = { draft: [], onHold: [], ingested: [], layoutWarning: [], holdWarning: holdWarnings };
  const seen = new Set();
  for (const rel of [...texts.keys()].sort()) {
    const text = texts.get(rel);
    const inside = rel.split('/').includes('examples');
    // Outside examples/, only the exact unqualified marker puts a file in
    // scope; a qualified marker (`Plan status:`) never matches.
    if (!inside && !/^Status:/m.test(text)) continue;
    seen.add(rel);
    const status = readStatus(text);
    const markedIngested = INGESTED_SPELLINGS.has(status);
    const evidenced = declared.has(rel) || firstIngest.has(rel);
    if (!inside && !markedIngested) {
      buckets.layoutWarning.push({ path: rel, status });
      continue;
    }
    const item = { path: rel, status, evidenced, origin: captureOrigin(text) };
    if (markedIngested || evidenced) {
      if (markedIngested && !evidenced) item.mismatch = 'marked-ingested-without-evidence';
      else if (evidenced && !markedIngested) item.mismatch = 'draft-with-evidence';
      if (holds.has(rel)) buckets.holdWarning.push(`${HOLDS_FILE}: a hold names an already Ingested capture (stale hold)`);
      buckets.ingested.push(item);
    } else if (holds.has(rel)) {
      item.hold = holds.get(rel);
      buckets.onHold.push(item);
    } else {
      buckets.draft.push(item);
    }
  }
  for (const held of holds.keys()) {
    if (!seen.has(held)) {
      buckets.holdWarning.push(`${HOLDS_FILE}: a hold matches no in-scope capture`);
    }
  }

  return { buckets, firstIngest, texts };
}

/**
 * Captures ingested since the newest maintenance pass: Ingested captures whose
 * *first* ingest log entry is newer (sits above) the pass. Position, not date,
 * decides. null when no pass is on record (the pass is simply due).
 */
export function ingestedSincePass(buckets, firstIngest, entries, lastPass) {
  return capturesSincePass(buckets, firstIngest, entries, lastPass)?.length ?? null;
}

/**
 * The captures `ingestedSincePass` counts, as `[{path, origin, ingestedOn}]`
 * (`ingestedOn` = the first ingest entry's date): bridge first, then newest
 * log entry first, then path. null when no pass is on record.
 */
export function capturesSincePass(buckets, firstIngest, entries, lastPass) {
  if (!lastPass) return null;
  const rank = (origin) => (origin === 'bridge' ? 0 : 1);
  return buckets.ingested
    .filter((item) => (firstIngest.get(item.path) ?? entries.length) < lastPass.index)
    .map((item) => ({
      path: item.path,
      origin: item.origin,
      index: firstIngest.get(item.path),
      ingestedOn: entries[firstIngest.get(item.path)].dateText,
    }))
    .sort(
      (a, b) =>
        rank(a.origin) - rank(b.origin)
        || a.index - b.index
        || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    )
    .map(({ path: p, origin, ingestedOn }) => ({ path: p, origin, ingestedOn }));
}

// ---------- capture age (aos_status.py `_capture_age`) ----------

const INTAKE_RE = /^knowledge_intake_date\s*:\s*(\S+)/m; // frontmatter.INTAKE_RE
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/; // frontmatter.ISO_DATE
const NAME_DATE_RE = /(\d{4}-\d{2}-\d{2})\.md$/; // aos_status.NAME_DATE_RE

/** Whole days from ISO day `from` to ISO day `to` (`date` subtraction, no clock). */
export function daysBetween(from, to) {
  const ms = (day) => {
    const [y, m, d] = day.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86400000);
}

/**
 * A capture's age in days on `today` (ISO day), exactly as `aos_status.py`
 * `_capture_age`: the frontmatter `knowledge_intake_date` (quotes stripped)
 * when it has ISO shape and is a real day, else the `YYYY-MM-DD.md` suffix of
 * the file name, else null. Never mtime or Git history (ADR-0003).
 */
export function captureAgeDays(text, relPath, today) {
  const fm = normalize(text).match(FRONTMATTER_BLOCK_RE)?.[1] ?? '';
  const intake = fm.match(INTAKE_RE)?.[1].replace(/^["']+|["']+$/g, '');
  let found = intake && ISO_DATE_RE.test(intake) && validDay(intake) ? intake : null;
  if (found === null) {
    const n = path.posix.basename(relPath).match(NAME_DATE_RE);
    found = n && validDay(n[1]) ? n[1] : null;
  }
  return found === null ? null : daysBetween(found, today);
}
