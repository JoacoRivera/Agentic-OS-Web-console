import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Evals view (read-only). The console never runs, drafts or judges an eval
 * (ADR-0001): it reads the verdicts the owner recorded in the memory repo.
 *
 * Mirrors the memory repo's own lint, line for line:
 *   - check 9  (`check_eval_results`, scripts/aos_wiki/lint.py) — the result
 *     file format: dated filename, H1, run headings, required fields, all on
 *     `strip_code(text)`;
 *   - check 23 (`check_eval_staleness`) — cases never run, the full-suite
 *     clock (`Run: full monthly suite`, due at 28 days).
 * When those checks change, this module and `check:evals` change with them.
 *
 * Known divergences: the filename date must be literally YYYY-MM-DD (Python's
 * `date.fromisoformat` also accepts basic/week forms; lint's own message asks
 * for YYYY-MM-DD.md); lines split on \r\n|\r|\n (Python `splitlines()` also
 * splits on a few rarer separators); symlinked files and directories are not
 * followed (lint's `rglob` reads symlinked files).
 *
 * Invalid data is excluded and surfaced as `{path, line, reason}` problems —
 * never guessed, never carrying file text.
 */

export const EVALS_ROOT = 'wiki/workflows/evals';
export const EVAL_RUN_HEADING =
  /^## (eval-[a-z0-9-]+)(?: \(([^)]+)\))? — (PASS|PARTIAL|FAIL)(?: \(([^)]+)\))?$/;
export const EVAL_RUN_FIELDS = [
  'target',
  'type',
  'must_include',
  'must_not_include',
  'verification',
  'action taken',
];
export const EVAL_VERDICTS = ['PASS', 'PARTIAL', 'FAIL'];
export const EVAL_SUITE_DUE_DAYS = 28;
export const EVAL_FULL_SUITE_LINE = 'Run: full monthly suite';
export const EVAL_PROBLEM_LIMIT = 20;

const EXEMPT_NAMES = new Set(['README.md', '_template.md']);
const EVAL_TYPES = /^(deterministic|judgment|mixed)\b/;
const FIELD_LINE = /^- ([a-z_ ]+):/;
const LOOSE_RUN_ID = /^## (eval-[a-z0-9-]+)/gm;
const CASE_ID = /^\s*id:\s*["']?(eval-[a-z0-9-]+)/m;
const CASE_TYPE = /^\s*type:\s*(deterministic|judgment|mixed)\b/m;

export const EVAL_ORDER_NOTE =
  'Runs carry a date, not a time. Within one date, records keep their file order, ' +
  'newest first by the results README convention (not lint-enforced).';

/** Python `str.splitlines()` analogue: no trailing empty element. */
function splitLines(text) {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Port of lint's `strip_code`: fenced blocks blanked (the fence lines too),
 * inline code spans removed, one output line per input line.
 */
export function stripCodeLines(lines) {
  const out = [];
  let fenced = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      out.push('');
      continue;
    }
    out.push(fenced ? '' : line.replace(/`[^`]*`/g, ''));
  }
  return out;
}

/** A real calendar date in the literal YYYY-MM-DD form, else null. */
export function parseIsoDate(stem) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(stem);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return stem;
}

/** Recursive `*.md` walk (lint's `rglob`), exempt names skipped, paths sorted. */
async function mdFiles(config, relDir) {
  const out = [];
  async function walk(rel) {
    let entries;
    try {
      entries = await fs.readdir(path.join(config.REPO_ROOT, rel), { withFileTypes: true });
    } catch {
      return; // missing directory → nothing, not an error
    }
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.endsWith('.md') && !EXEMPT_NAMES.has(entry.name)) {
        out.push(child);
      }
    }
  }
  await walk(relDir);
  return out.sort();
}

/**
 * Parse one dated result file (lint check 9 + the check-23 inputs).
 * Returns { runs, problems, looseIds, fullSuite }.
 */
export function parseResultFile(relPath, date, text) {
  const raw = splitLines(text);
  const lines = stripCodeLines(raw);
  const problems = [];
  const runs = [];

  const h1 = lines.find((l) => l.startsWith('# '));
  if (h1 !== `# Eval Results — ${date}`) {
    problems.push({ path: relPath, line: h1 === undefined ? null : lines.indexOf(h1) + 1, reason: 'bad-h1' });
  }

  let current = null;
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (line.startsWith('## ')) {
      const m = EVAL_RUN_HEADING.exec(line);
      if (!m) {
        problems.push({ path: relPath, line: lineNo, reason: 'malformed-heading' });
        current = null; // following fields attach to nothing, as in lint
        return;
      }
      current = {
        id: m[1],
        date,
        path: relPath,
        line: lineNo,
        verdict: m[3],
        subject: m[2] ?? null,
        note: m[4] ?? null,
        type: null,
        confirmed: false,
        fields: new Set(),
      };
      runs.push(current);
      return;
    }
    if (current === null) return;
    const field = FIELD_LINE.exec(line);
    if (field) {
      if (field[1] === 'type' && !current.fields.has('type')) {
        const value = raw[index].replace(/^- type:\s*`?/, '');
        current.type = EVAL_TYPES.exec(value)?.[1] ?? null;
      }
      current.fields.add(field[1]);
    } else if (line.startsWith('- Confirmed by:')) {
      current.confirmed = true;
    }
  });

  if (runs.length === 0) problems.push({ path: relPath, line: null, reason: 'no-run-blocks' });
  for (const run of runs) {
    run.missingFields = EVAL_RUN_FIELDS.filter((f) => !run.fields.has(f));
    if (run.missingFields.length) {
      problems.push({ path: relPath, line: run.line, reason: 'missing-fields' });
    }
    delete run.fields;
  }

  // Check 23 inputs: the full-suite line before the first `## `, and the loose
  // "ever run" id regex (a malformed heading still counts as run).
  let firstRun = lines.findIndex((l) => l.startsWith('## '));
  if (firstRun === -1) firstRun = lines.length;
  const fullSuite = lines.slice(0, firstRun).some((l) => l.trim() === EVAL_FULL_SUITE_LINE);
  const looseIds = [...lines.join('\n').matchAll(LOOSE_RUN_ID)].map((m) => m[1]);

  return { runs, problems, looseIds, fullSuite };
}

/** Parse one case page: id (lint `eval_case_id`), title, type. */
export function parseCaseFile(relPath, text) {
  const stem = path.posix.basename(relPath).replace(/\.md$/, '');
  const raw = splitLines(text);
  const stripped = stripCodeLines(raw);
  const h1Index = stripped.findIndex((l) => l.startsWith('# '));
  return {
    id: CASE_ID.exec(text)?.[1] ?? `eval-${stem}`,
    path: relPath,
    title: h1Index === -1 ? null : raw[h1Index].slice(2).trim(),
    type: CASE_TYPE.exec(text)?.[1] ?? null,
  };
}

/** Local calendar date of `now` as YYYY-MM-DD (lint uses `date.today()`). */
function localDate(now) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function daysBetween(from, to) {
  const utc = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/** GET /api/evals — a live scan of wiki/workflows/evals/{results,cases}. */
export async function listEvals(config, now = new Date()) {
  const [resultPaths, casePaths] = await Promise.all([
    mdFiles(config, `${EVALS_ROOT}/results`),
    mdFiles(config, `${EVALS_ROOT}/cases`),
  ]);

  const problems = [];
  const allRuns = [];
  const looseIds = new Set();
  const fullSuiteDates = [];
  let resultFiles = 0;

  for (const relPath of resultPaths) {
    const stem = path.posix.basename(relPath).replace(/\.md$/, '');
    const date = parseIsoDate(stem);
    if (!date) {
      problems.push({ path: relPath, line: null, reason: 'bad-filename' });
      continue;
    }
    resultFiles += 1;
    const text = await fs.readFile(path.join(config.REPO_ROOT, relPath), 'utf8');
    const parsed = parseResultFile(relPath, date, text);
    allRuns.push(...parsed.runs.map((run, position) => ({ ...run, position })));
    problems.push(...parsed.problems);
    parsed.looseIds.forEach((id) => looseIds.add(id));
    if (parsed.fullSuite) fullSuiteDates.push(date);
  }

  const cases = new Map();
  for (const relPath of casePaths) {
    const text = await fs.readFile(path.join(config.REPO_ROOT, relPath), 'utf8');
    const parsed = parseCaseFile(relPath, text);
    // Lint has no rule against two pages sharing an id; the first page (path
    // order) is the case, the other is surfaced, not silently dropped.
    if (cases.has(parsed.id)) problems.push({ path: relPath, line: null, reason: 'duplicate-case-id' });
    else cases.set(parsed.id, parsed);
  }

  // Newest first: file date descending, then position in file ascending.
  allRuns.sort((a, b) => (a.date === b.date ? a.position - b.position : a.date < b.date ? 1 : -1));
  const runsById = new Map();
  for (const { position, id, ...run } of allRuns) {
    if (!runsById.has(id)) runsById.set(id, []);
    runsById.get(id).push(run);
  }

  const ids = [...new Set([...cases.keys(), ...runsById.keys()])].sort();
  const evals = ids.map((id) => {
    const runs = runsById.get(id) ?? [];
    const kase = cases.get(id);
    const counts = Object.fromEntries(EVAL_VERDICTS.map((v) => [v, 0]));
    runs.forEach((r) => (counts[r.verdict] += 1));
    return {
      id,
      case: kase ? { path: kase.path, title: kase.title, type: kase.type } : null,
      // Check 23's loose "ever run": true even when every heading for this
      // id is malformed (then `runs` is empty but the case is not never-run).
      everRun: looseIds.has(id),
      lastRunDate: runs[0]?.date ?? null,
      latest: runs[0] ? { verdict: runs[0].verdict, date: runs[0].date } : null,
      counts,
      runs,
    };
  });

  fullSuiteDates.sort();
  const lastFullSuiteDate = fullSuiteDates.at(-1) ?? null;
  const ageDays = lastFullSuiteDate ? daysBetween(lastFullSuiteDate, localDate(now)) : null;
  // Check 23 returns early with no suite; with one, a missing full-suite run
  // is itself "due".
  const due =
    cases.size === 0 ? false : lastFullSuiteDate === null ? true : ageDays >= EVAL_SUITE_DUE_DAYS;

  return {
    root: EVALS_ROOT,
    evals,
    suite: {
      cases: cases.size,
      resultFiles,
      runs: allRuns.length,
      lastRunDate: allRuns[0]?.date ?? null,
      fullSuiteDates,
      lastFullSuiteDate,
      neverFullSuite: lastFullSuiteDate === null,
      ageDays,
      dueDays: EVAL_SUITE_DUE_DAYS,
      due,
      neverRun: [...cases.keys()].filter((id) => !looseIds.has(id)).sort(),
      withoutCase: [...runsById.keys()].filter((id) => !cases.has(id)).sort(),
    },
    problemCount: problems.length,
    problems: problems.slice(0, EVAL_PROBLEM_LIMIT),
    orderNote: EVAL_ORDER_NOTE,
    generatedAt: now.toISOString(),
  };
}
