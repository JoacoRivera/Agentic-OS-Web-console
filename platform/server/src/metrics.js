import fs from 'node:fs/promises';
import path from 'node:path';
import { getPathAddedDates, creationFallbackMs } from './gitdates.js';

/**
 * Canonical memory metrics (ADR-0002): a live filesystem scan porting the
 * exact definitions from `dashboards/aos-hud.js`, with one deliberate
 * change — the 30-day growth series is keyed on `pathAddedDate` (Git first
 * saw the path), not fs ctime, and measures repository file growth, NOT
 * knowledge accumulation (ADR-0003).
 *
 * The HUD counts Dataview *pages*, i.e. markdown files; `.gitkeep` (and any
 * non-.md file) is never a page.
 */

const SKIP_BASENAMES = new Set(['index', 'log', '_template', 'README']);
const SCAN_ROOTS = ['wiki', 'raw', 'templates', 'dashboards'];
const GROWTH_DAYS = 30;
const WEEK_DAYS = 7;

/**
 * Approval marker for a capture: a plain single-colon `Status:` body line
 * (inline `Status: Approved` or a following list item `Status:\n- Approved`).
 * Exact HUD regex. Applied to the *full* file text — frontmatter included,
 * which also covers the HUD's Dataview-field check, since a frontmatter
 * `status:` line is the first match the regex can find.
 */
const APPROVED_RE = /^[ \t]*status[ \t]*:[ \t]*(?:\r?\n[ \t]*)*(?:[-*][ \t]*)?([a-z]+)/im;

export function isApprovedText(text) {
  const m = (text || '').match(APPROVED_RE);
  return !!m && m[1].toLowerCase() === 'approved';
}

/** HUD gauge target: next multiple of 5 strictly above v, floor 5. */
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
    } catch {
      return; // missing root — zero pages
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
          birthCandidateMs: creationFallbackMs(stat),
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

export async function computeMetrics(config, now = new Date()) {
  const repoRoot = config.REPO_ROOT;
  const [pathAdded, ...rootPages] = await Promise.all([
    getPathAddedDates(repoRoot),
    ...SCAN_ROOTS.map((root) => collectPages(repoRoot, root)),
  ]);
  const byRoot = Object.fromEntries(SCAN_ROOTS.map((root, i) => [root, rootPages[i]]));

  // ---- scalar counts (HUD collection rules; raw metrics always computed,
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

  // ---- 30-day cumulative growth by pathAddedDate (ADR-0003) ----
  const createdMs = (p) => pathAdded.get(p.path) ?? p.birthCandidateMs;
  const startMs = dayStartMs(now, -(GROWTH_DAYS - 1));
  const series = [];
  for (let i = 0; i < GROWTH_DAYS; i++) {
    const endOfDay = dayStartMs(now, -(GROWTH_DAYS - 1) + i + 1) - 1;
    series.push({
      d: isoDay(dayStartMs(now, -(GROWTH_DAYS - 1) + i)),
      v: all.filter((p) => createdMs(p) <= endOfDay).length,
    });
  }
  const last30 = all.filter((p) => createdMs(p) >= startMs).length;

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
