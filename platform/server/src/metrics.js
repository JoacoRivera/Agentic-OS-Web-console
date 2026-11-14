import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import {
  MAINTENANCE_DUE_DAYS,
  MAINTENANCE_OVERDUE_DAYS,
  capturesSincePass,
  classifyCaptures,
  ingestedSincePass,
  isLogFile,
  lastMaintenancePass,
  readLogEntries,
} from './captures.js';
import { calendarDay } from './dates.js';
import { collectReviewBy } from './reviewBy.js';
import { computeFlow } from './flow.js';

/**
 * Canonical memory metrics (ADR-0002): a live filesystem scan. Scalar file
 * counts use the console contract, while the growth series uses explicit
 * intake lineage (ADR-0003 amendment) and therefore measures
 * distinct knowledge sources rather than repository paths.
 *
 * Counts operate on Markdown files; `.gitkeep` (and any non-.md file) is
 * never a page.
 */

const SKIP_BASENAMES = new Set(['index', 'log', '_template', 'README']);
const SCAN_ROOTS = ['wiki', 'raw', 'templates'];
const GROWTH_DAYS = 30;
const WEEK_DAYS = 7;
const LINEAGE_PROBLEM_LIMIT = 20;

// Agentic OS schema (AGENTS.md): `source_id` is a UUID generated once when
// knowledge first enters the wiki. Canonical 8-4-4-4-12 hex textual form,
// case-insensitive; no version/variant nibble is enforced.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LINEAGE_REASON = Object.freeze({
  CONFLICTING_SOURCE_ID: 'conflicting-source-id',
  FUTURE_INTAKE_DATE: 'future-intake-date',
  INVALID_FRONTMATTER: 'invalid-frontmatter',
  INVALID_INTAKE_DATE: 'invalid-intake-date',
  INVALID_PROMOTED_FROM_LINEAGE: 'invalid-promoted-from-lineage',
  INVALID_SOURCE_ID: 'invalid-source-id',
  MISSING_LINEAGE: 'missing-lineage',
  MISSING_PROMOTED_FROM: 'missing-promoted-from',
  ORIGIN_AND_PROMOTION: 'origin-and-promotion',
  PARTIAL_ORIGIN: 'partial-origin',
  PROMOTION_CYCLE: 'promotion-cycle',
  UNREADABLE_FILE: 'unreadable-file',
  UNSAFE_PROMOTED_FROM: 'unsafe-promoted-from',
});

const skip = (page) => SKIP_BASENAMES.has(page.name);
const isEx = (page) => page.folder.includes('examples');
const inFolder = (page, folder) => page.path === folder || page.path.startsWith(folder + '/');

/** Recursively collect markdown "pages" under `root` (repo-relative). */
export async function collectPages(repoRoot, root) {
  const pages = [];
  async function walk(rel) {
    let entries;
    try {
      entries = await fs.readdir(path.join(repoRoot, rel), { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return; // missing root/directory — zero pages
      throw error;
    }
    for (const entry of entries) {
      const relPath = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== '.git') await walk(relPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const stat = await fs.stat(path.join(repoRoot, relPath));
        pages.push({
          path: relPath,
          name: entry.name.slice(0, -3),
          folder: path.dirname(relPath),
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  }
  await walk(root);
  return pages;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Local calendar-day start, `offsetDays` from `date` (Date handles DST rollover).
const dayStartMs = (date, offsetDays = 0) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + offsetDays).getTime();
const isoDay = (ms) => {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * The exact frontmatter source text of the top-level
 * `knowledge_intake_date` scalar — `null` when the key is absent or not
 * top-level. YAML collapses `2026-07-27`, `2026-07-27T10:00:00Z` and even the
 * impossible `2026-02-30` into ordinary Dates, so the parsed value alone cannot
 * tell a bare intake day from a timestamp, quoted scalar, or typo. Extract from
 * the original text because gray-matter's cached result omits `file.matter`.
 */
function intakeDateSource(text) {
  const frontmatter = (text || '').match(
    /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
  );
  if (!frontmatter) return null;
  const line = frontmatter[1].match(/^knowledge_intake_date[ \t]*:(.*)$/m);
  if (!line) return null;
  return line[1].trim();
}

function intakeDay(value, source) {
  if (value === undefined || value === null) return null;
  return calendarDay(source);
}

function promotedPaths(value) {
  const values = Array.isArray(value) ? value : [value];
  if (
    values.length === 0
    || values.some((item) => typeof item !== 'string' || item.trim() === '')
  ) {
    return null;
  }
  const refs = values.map((item) => item.trim().replaceAll('\\', '/'));
  if (
    !refs.every(
      (item) =>
        item.startsWith('raw/')
        && item.endsWith('.md')
        && !item.startsWith('/')
        && !item.split('/').includes('..')
    )
  ) {
    return null;
  }
  return [...new Set(refs.map(path.posix.normalize))];
}

function parseLineage(text) {
  let file;
  try {
    file = matter(text);
  } catch {
    // gray-matter inserts the file object into `matter.cache` *before* it
    // parses, so a YAML failure leaves a `data: {}` stub behind. A later parse
    // of identical text would hit that stub and downgrade this file from
    // `invalid-frontmatter` to `missing-lineage` — a different verdict on the
    // second /api/metrics request than on the first. Evict the poisoned entry:
    // a file's lineage verdict must not depend on how often metrics ran.
    delete matter.cache[text];
    return { kind: 'invalid', reason: LINEAGE_REASON.INVALID_FRONTMATTER };
  }
  const data = file.data;

  const hasSourceId = Object.hasOwn(data, 'source_id');
  const hasIntakeDate = Object.hasOwn(data, 'knowledge_intake_date');
  const hasPromotedFrom = Object.hasOwn(data, 'promoted_from');

  if (hasPromotedFrom) {
    if (hasSourceId || hasIntakeDate) {
      return { kind: 'invalid', reason: LINEAGE_REASON.ORIGIN_AND_PROMOTION };
    }
    const refs = promotedPaths(data.promoted_from);
    return refs
      ? { kind: 'derived', refs }
      : { kind: 'invalid', reason: LINEAGE_REASON.UNSAFE_PROMOTED_FROM };
  }
  if (!hasSourceId && !hasIntakeDate) {
    return { kind: 'unlineaged', reason: LINEAGE_REASON.MISSING_LINEAGE };
  }
  if (hasSourceId !== hasIntakeDate) {
    return { kind: 'invalid', reason: LINEAGE_REASON.PARTIAL_ORIGIN };
  }
  const sourceId = typeof data.source_id === 'string' ? data.source_id : '';
  if (!sourceId || !UUID_RE.test(sourceId)) {
    return { kind: 'invalid', reason: LINEAGE_REASON.INVALID_SOURCE_ID };
  }
  const date = intakeDay(data.knowledge_intake_date, intakeDateSource(text));
  return date
    ? { kind: 'origin', sourceId: sourceId.toLowerCase(), date }
    : { kind: 'invalid', reason: LINEAGE_REASON.INVALID_INTAKE_DATE };
}

/**
 * Reason histogram over *every* lineage problem, not just the capped sample.
 * `problems` stays a bounded 20-path diagnostic; `reasonCounts` describes the
 * shape of the whole backlog so a truncated sample can never make the tail
 * look empty. Counts only — no extra paths, no body text — and the values sum
 * to `unlineagedN + invalidN`. Keys are sorted so the payload is byte-stable.
 */
function countByReason(problems) {
  const counts = new Map();
  for (const { reason } of problems) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return Object.fromEntries(
    [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );
}

async function computeKnowledgeLineage(repoRoot, pages, throughDay) {
  const records = new Map();
  await Promise.all(
    pages.map(async (page) => {
      try {
        const text = await fs.readFile(path.join(repoRoot, page.path), 'utf8');
        records.set(page.path, parseLineage(text));
      } catch {
        records.set(page.path, {
          kind: 'invalid',
          reason: LINEAGE_REASON.UNREADABLE_FILE,
        });
      }
    })
  );

  const resolutions = new Map();
  const resolutionProblems = new Map();
  const resolve = (relPath, visiting = []) => {
    if (resolutions.has(relPath)) return resolutions.get(relPath);
    const record = records.get(relPath);
    if (!record) {
      return { sources: null, reason: LINEAGE_REASON.MISSING_PROMOTED_FROM };
    }
    if (record.kind === 'invalid' || record.kind === 'unlineaged') {
      return { sources: null, reason: LINEAGE_REASON.INVALID_PROMOTED_FROM_LINEAGE };
    }
    if (record.kind === 'origin') {
      const result = { sources: new Map([[record.sourceId, record.date]]), reason: null };
      resolutions.set(relPath, result);
      return result;
    }
    const cycleAt = visiting.indexOf(relPath);
    if (cycleAt !== -1) {
      for (const cyclePath of visiting.slice(cycleAt)) {
        resolutionProblems.set(cyclePath, LINEAGE_REASON.PROMOTION_CYCLE);
      }
      resolutionProblems.set(relPath, LINEAGE_REASON.PROMOTION_CYCLE);
      return { sources: null, reason: LINEAGE_REASON.PROMOTION_CYCLE };
    }
    const next = [...visiting, relPath];
    const sources = new Map();
    for (const ref of record.refs) {
      const inherited = resolve(ref, next);
      if (!inherited.sources) {
        resolutionProblems.set(relPath, inherited.reason);
        const result = { sources: null, reason: inherited.reason };
        resolutions.set(relPath, result);
        return result;
      }
      for (const [sourceId, date] of inherited.sources) {
        if (sources.has(sourceId) && sources.get(sourceId) !== date) {
          const result = {
            sources: null,
            reason: LINEAGE_REASON.CONFLICTING_SOURCE_ID,
          };
          resolutionProblems.set(relPath, result.reason);
          resolutions.set(relPath, result);
          return result;
        }
        sources.set(sourceId, date);
      }
    }
    const result = { sources, reason: null };
    resolutions.set(relPath, result);
    return result;
  };

  const datesBySource = new Map();
  for (const [relPath, record] of records) {
    if (record.kind !== 'origin') continue;
    const dates = datesBySource.get(record.sourceId) ?? new Set();
    dates.add(record.date);
    datesBySource.set(record.sourceId, dates);
  }
  for (const [relPath, record] of records) {
    if (record.kind === 'derived') resolve(relPath);
  }

  const conflictingIds = new Set(
    [...datesBySource].filter(([, dates]) => dates.size > 1).map(([sourceId]) => sourceId)
  );
  const futureIds = new Set(
    [...datesBySource]
      .filter(([, dates]) => dates.size === 1 && [...dates][0] > throughDay)
      .map(([sourceId]) => sourceId)
  );
  const invalidIds = new Set([...conflictingIds, ...futureIds]);
  const events = [...datesBySource]
    .filter(([sourceId, dates]) => !invalidIds.has(sourceId) && dates.size === 1)
    .map(([sourceId, dates]) => ({ sourceId, date: [...dates][0] }));

  let lineagedN = 0;
  let unlineagedN = 0;
  let invalidN = 0;
  let promotedN = 0;
  const problems = [];
  const addProblem = (relPath, reason) => {
    problems.push({ path: relPath, reason });
  };
  for (const [relPath, record] of [...records].sort(([a], [b]) => (
    a < b ? -1 : a > b ? 1 : 0
  ))) {
    if (record.kind === 'unlineaged') {
      unlineagedN++;
      addProblem(relPath, record.reason);
      continue;
    }
    if (record.kind === 'invalid') {
      invalidN++;
      addProblem(relPath, record.reason);
      continue;
    }
    const resolved = resolve(relPath);
    let reason = resolutionProblems.get(relPath) ?? resolved.reason;
    if (!reason && [...resolved.sources.keys()].some((sourceId) => conflictingIds.has(sourceId))) {
      reason = LINEAGE_REASON.CONFLICTING_SOURCE_ID;
    }
    if (!reason && [...resolved.sources.keys()].some((sourceId) => futureIds.has(sourceId))) {
      reason = LINEAGE_REASON.FUTURE_INTAKE_DATE;
    }
    if (reason) {
      invalidN++;
      addProblem(relPath, reason);
      continue;
    }
    lineagedN++;
    if (record.kind === 'derived') promotedN++;
  }
  problems.sort((a, b) => {
    if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  return {
    events,
    summary: {
      eligibleN: pages.length,
      lineagedN,
      unlineagedN,
      invalidN,
      promotedN,
      conflictingSourceIdsN: conflictingIds.size,
      futureDatedSourceIdsN: futureIds.size,
      reasonCounts: countByReason(problems),
      problems: problems.slice(0, LINEAGE_PROBLEM_LIMIT),
    },
  };
}

export async function computeMetrics(config, now = new Date()) {
  const repoRoot = config.REPO_ROOT;
  const rootPages = await Promise.all(SCAN_ROOTS.map((root) => collectPages(repoRoot, root)));
  const byRoot = Object.fromEntries(SCAN_ROOTS.map((root, i) => [root, rootPages[i]]));

  // ---- scalar counts (canonical console rules; raw metrics always computed,
  // regardless of EXPOSE_RAW_CONTENT — that flag gates content, ADR-0005) ----
  // The log archive `wiki/log/YYYY-MM.md` is the log, not a page — exempt from
  // every page rule exactly like log.md (memory repo wiki_log.is_log_file).
  const wiki = byRoot.wiki.filter((p) => !skip(p) && !isLogFile(p.path));
  const raw = byRoot.raw.filter((p) => !skip(p) && p.name !== '.gitkeep');
  // NB: `all` excludes only `_template` — index/log/README stay counted here.
  const all = SCAN_ROOTS.flatMap((root) => byRoot[root]).filter((p) => p.name !== '_template');

  const examples = wiki.filter(isEx).length;
  const projects = byRoot.wiki.filter((p) => inFolder(p, 'wiki/projects')).length;
  const workflows = byRoot.wiki.filter((p) => inFolder(p, 'wiki/workflows') && !isEx(p)).length;
  const rawProj = byRoot.raw.filter((p) => inFolder(p, 'raw/projects') && !skip(p)).length;
  const rawFlow = byRoot.raw.filter(
    (p) => inFolder(p, 'raw/workflows') && !skip(p) && p.name !== '_template'
  ).length;

  // ---- captures: Draft / on hold / Ingested (memory repo ADR-0002) ----
  // Same classification as the memory repo's capture inventory: no triage, no
  // approval — a Draft waits only for /aos-ingest. rawN never drains (ADR-0003).
  const logEntries = await readLogEntries(repoRoot);
  const { buckets, firstIngest, texts } = await classifyCaptures(
    repoRoot,
    byRoot.raw.map((p) => p.path),
    byRoot.wiki.map((p) => p.path),
    logEntries
  );
  const rawByPath = new Map(byRoot.raw.map((p) => [p.path, p]));
  const listed = (items, extra = () => ({})) =>
    items
      .map((item) => ({ item, page: rawByPath.get(item.path) }))
      .sort((a, b) => b.page.mtimeMs - a.page.mtimeMs)
      .slice(0, config.DRAFT_LIMIT)
      .map(({ item, page }) => ({
        name: page.name,
        path: page.path,
        mtime: new Date(page.mtimeMs).toISOString(),
        origin: item.origin,
        ...extra(item),
      }));
  const draftN = buckets.draft.length;
  const heldN = buckets.onHold.length;
  const ingestedN = buckets.ingested.length;
  const capN = draftN + heldN + ingestedN;
  const captures = {
    legacyApprovedN: buckets.ingested.filter((i) => i.status === 'Approved').length,
    mismatchN: buckets.ingested.filter((i) => i.mismatch).length,
    layoutWarningN: buckets.layoutWarning.length,
    holdWarningN: buckets.holdWarning.length,
    // Memory Bridge captures per bucket (memory repo ADR-0003); origin is an
    // attribute, never a state — these are subsets of draftN/heldN/ingestedN.
    bridge: {
      draftN: buckets.draft.filter((i) => i.origin === 'bridge').length,
      heldN: buckets.onHold.filter((i) => i.origin === 'bridge').length,
      ingestedN: buckets.ingested.filter((i) => i.origin === 'bridge').length,
    },
  };
  const drafts = listed(buckets.draft);
  const held = listed(buckets.onHold, (item) => ({ reason: item.hold }));

  // ---- 30-day cumulative knowledge intake (ADR-0003 amendment) ----
  // Missing/invalid lineage is excluded rather than guessed from Git or fs
  // timestamps. The coverage summary makes that incompleteness explicit.
  const { events: intakeEvents, summary: lineage } = await computeKnowledgeLineage(
    repoRoot,
    [...wiki, ...raw],
    isoDay(dayStartMs(now))
  );
  const startDay = isoDay(dayStartMs(now, -(GROWTH_DAYS - 1)));
  const series = [];
  for (let i = 0; i < GROWTH_DAYS; i++) {
    const day = isoDay(dayStartMs(now, -(GROWTH_DAYS - 1) + i));
    series.push({
      d: day,
      v: intakeEvents.filter((event) => event.date <= day).length,
    });
  }
  const knowledgeN = intakeEvents.length;
  const last30 = intakeEvents.filter((event) => event.date >= startDay).length;

  // ---- 7-day activity by mtime ----
  const week = [];
  for (let i = WEEK_DAYS - 1; i >= 0; i--) {
    const d0 = dayStartMs(now, -i);
    const d1 = dayStartMs(now, -i + 1) - 1;
    week.push({
      d: isoDay(d0),
      c: all.filter((p) => p.mtimeMs >= d0 && p.mtimeMs <= d1).length,
    });
  }
  const weekTotal = week.reduce((a, b) => a + b.c, 0);
  const activeDays = week.filter((b) => b.c > 0).length;

  // ---- recent activity ----
  const recent = [...all]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, config.RECENT_ACTIVITY_LIMIT)
    .map((p) => ({ name: p.name, path: p.path, mtime: new Date(p.mtimeMs).toISOString() }));

  // ---- maintenance-pass cadence (memory repo wiki_log.py) ----
  // Only a `lint | maintenance pass` entry resets the 7-day timer — other
  // `lint` entries do not — read across wiki/log.md and its monthly archive.
  const pass = lastMaintenancePass(logEntries);
  const lastPass = pass?.dateText ?? null;
  const passAge = lastPass
    ? Math.round((dayStartMs(now) - dayStartMs(new Date(`${lastPass}T00:00:00`))) / DAY_MS)
    : null;
  const healthStale = passAge === null || passAge >= MAINTENANCE_DUE_DAYS;
  const overdue = passAge === null || passAge >= MAINTENANCE_OVERDUE_DAYS;
  const ageLabel =
    passAge === null ? 'NEVER' : passAge <= 0 ? 'TODAY' : passAge === 1 ? '1 DAY AGO' : `${passAge} DAYS AGO`;

  // ---- review-by dates (wiki-lint check 25), wiki-wide, information only ----
  // Every wiki/ page lint scans (index/README included), the log excepted.
  // Accepted cost: this re-reads pages the lineage pass already read (~400 small files).
  const reviewBy = await collectReviewBy(repoRoot, byRoot.wiki.map((p) => p.path), now);
  // ---- captures ingested since that pass, by origin ----
  // Full counts in byOrigin; the list is capped, bridge rows first so the cap
  // drops `other` rows before any bridge row. Path/name/date/origin only.
  const sinceItems = capturesSincePass(buckets, firstIngest, logEntries, pass);
  const sincePass = sinceItems && {
    byOrigin: {
      bridge: sinceItems.filter((i) => i.origin === 'bridge').length,
      other: sinceItems.filter((i) => i.origin !== 'bridge').length,
    },
    items: sinceItems.slice(0, config.SINCE_PASS_LIMIT).map((i) => ({
      name: rawByPath.get(i.path)?.name ?? path.basename(i.path, '.md'),
      path: i.path,
      origin: i.origin,
      ingestedOn: i.ingestedOn,
    })),
    truncated: sinceItems.length > config.SINCE_PASS_LIMIT,
  };

  return {
    wikiN: wiki.length,
    rawN: raw.length,
    // Total *files* across tiers; double-counts a promoted item (raw source
    // AND wiki synthesis) — never "total memory" (ADR-0003).
    all: all.length,
    examples,
    projects,
    workflows,
    rawProj,
    rawFlow,
    capN,
    draftN,
    heldN,
    ingestedN,
    captures,
    drafts,
    held,
    knowledgeN,
    lineage,
    series,
    last30,
    week,
    weekTotal,
    activeDays,
    recent,
    health: {
      lastPass,
      passAge,
      healthStale, // the maintenance pass is due
      overdue,
      ageLabel,
      staleDays: MAINTENANCE_DUE_DAYS,
      overdueDays: MAINTENANCE_OVERDUE_DAYS,
      ingestedSincePass: ingestedSincePass(buckets, firstIngest, logEntries, pass),
      reviewBy, // never feeds healthStale/overdue — the cadence is the pass alone
      sincePass,
    },
    // Memory-flow stats (ADR-0003 amendment 2026-11-14, mirrors memory-stats.py).
    flow: computeFlow({ buckets, texts, entries: logEntries, today: isoDay(dayStartMs(now)) }),
    trend: weekTotal > 0 ? 'ACTIVE' : 'IDLE',
    generatedAt: now.toISOString(),
  };
}
