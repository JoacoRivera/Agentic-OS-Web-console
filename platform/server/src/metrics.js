import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';

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

/**
 * Approval marker for a capture: a plain single-colon `Status:` body line
 * (inline `Status: Approved` or a following list item `Status:\n- Approved`).
 * Applied to the *full* file text, including frontmatter; the first matching
 * `status:` line determines the result.
 */
const APPROVED_RE = /^[ \t]*status[ \t]*:[ \t]*(?:\r?\n[ \t]*)*(?:[-*][ \t]*)?([a-z]+)/im;

export function isApprovedText(text) {
  const m = (text || '').match(APPROVED_RE);
  return !!m && m[1].toLowerCase() === 'approved';
}

/** Gauge target: next multiple of 5 strictly above v, floor 5. */
export function target(v) {
  return Math.max(5, Math.ceil((v + 1) / 5) * 5);
}

const skip = (page) => SKIP_BASENAMES.has(page.name);
const isEx = (page) => page.folder.includes('examples');
const inFolder = (page, folder) => page.path === folder || page.path.startsWith(folder + '/');

/** Recursively collect markdown "pages" under `root` (repo-relative). */
async function collectPages(repoRoot, root) {
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

/** A real `YYYY-MM-DD` calendar day, or null (rejects Feb 30, month 13, …). */
function calendarDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const [year, month, date] = day.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, date));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === date
    ? day
    : null;
}

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
  const sourceId = typeof data.source_id === 'string' ? data.source_id.trim() : '';
  if (!sourceId) {
    return { kind: 'invalid', reason: LINEAGE_REASON.INVALID_SOURCE_ID };
  }
  const date = intakeDay(data.knowledge_intake_date, intakeDateSource(text));
  return date
    ? { kind: 'origin', sourceId, date }
    : { kind: 'invalid', reason: LINEAGE_REASON.INVALID_INTAKE_DATE };
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
  const wiki = byRoot.wiki.filter((p) => !skip(p));
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

  // ---- captures: draft vs approved review queue ----
  // draftN is the review queue (drained by a `status` edit inside the raw
  // file); promotion ≠ approval, and rawN never drains (ADR-0003).
  const captures = raw.filter(isEx);
  const capStatus = await Promise.all(
    captures.map(async (p) => {
      let approved = false;
      try {
        approved = isApprovedText(await fs.readFile(path.join(repoRoot, p.path), 'utf8'));
      } catch {
        /* unreadable → draft */
      }
      return { p, approved };
    })
  );
  const draftPages = capStatus
    .filter((s) => !s.approved && s.p.mtimeMs)
    .map((s) => s.p)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const capN = captures.length;
  const apprN = capStatus.filter((s) => s.approved).length;
  const draftN = draftPages.length;
  const drafts = draftPages
    .slice(0, config.DRAFT_LIMIT)
    .map((p) => ({ name: p.name, path: p.path, mtime: new Date(p.mtimeMs).toISOString() }));

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

  // ---- memory-health cadence: first `lint` entry in wiki/log.md ----
  let lastLint = null;
  try {
    const logText = await fs.readFile(path.join(repoRoot, 'wiki/log.md'), 'utf8');
    const m = logText.match(/^##\s*\[(\d{4}-\d{2}-\d{2})\]\s+lint\s*\|/m);
    if (m) lastLint = m[1];
  } catch {
    /* log unreadable — treated as "never" (stale) */
  }
  const lintAge = lastLint
    ? Math.floor((dayStartMs(now) - dayStartMs(new Date(`${lastLint}T00:00:00`))) / DAY_MS)
    : null;
  const healthStale = lintAge === null || lintAge >= config.LINT_STALE_DAYS;
  const ageLabel =
    lintAge === null ? 'NEVER' : lintAge <= 0 ? 'TODAY' : lintAge === 1 ? '1 DAY AGO' : `${lintAge} DAYS AGO`;

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
    apprN,
    drafts,
    knowledgeN,
    lineage,
    series,
    last30,
    week,
    weekTotal,
    activeDays,
    recent,
    health: {
      lastLint,
      lintAge,
      healthStale,
      ageLabel,
      staleDays: config.LINT_STALE_DAYS,
    },
    targets: {
      wikiN: target(wiki.length),
      rawN: target(raw.length),
      weekTotal: target(weekTotal),
    },
    trend: weekTotal > 0 ? 'ACTIVE' : 'IDLE',
    generatedAt: now.toISOString(),
  };
}
