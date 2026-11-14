// check:evals — deterministic parity check of the Evals view (GET /api/evals)
// against an INDEPENDENT recount of wiki/workflows/evals/ in the live memory
// repo: its own directory walk and plain line-prefix counting, no regex or
// parser shared with server/src/evals.js, so a scanner regression cannot make
// both sides agree by construction. Prints COUNTS ONLY.
//
// Read-only: the console never runs or judges an eval (ADR-0001). Not in the
// Phase-3 executable allowlist (same as check:family-health).
//
// Usage: REPO_ROOT=<memory repo> node scripts/check-evals.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createConfig } from '../server/src/config.js';
import { listEvals, EVAL_PROBLEM_LIMIT } from '../server/src/evals.js';

const config = createConfig(process.env);
const EVALS = 'wiki/workflows/evals';

let failed = 0;
const record = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

function walk(relDir) {
  const out = [];
  const abs = path.join(config.REPO_ROOT, relDir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = `${relDir}/${entry.name}`;
    // Symlinks are skipped, as the server scanner does (a documented
    // divergence from lint's rglob).
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md' && entry.name !== '_template.md') out.push(rel);
  }
  return out;
}

function isRealDate(stem) {
  if (stem.length !== 10 || stem[4] !== '-' || stem[7] !== '-') return false;
  const d = new Date(`${stem}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === stem;
}

/** Lines outside ``` / ~~~ fences (fence lines dropped). */
function unfencedLines(text) {
  const out = [];
  let fenced = false;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.trimStart();
    if (t.startsWith('```') || t.startsWith('~~~')) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) out.push(line);
  }
  return out;
}

const api = await listEvals(config);

// ---- results/ -------------------------------------------------------------
const resultMd = walk(`${EVALS}/results`);
const dated = resultMd.filter((rel) => isRealDate(path.posix.basename(rel, '.md')));
const undated = resultMd.filter((rel) => !dated.includes(rel));
let headings = 0;
const verdictTotals = { PASS: 0, PARTIAL: 0, FAIL: 0 };
const fullSuite = [];
for (const rel of dated) {
  const lines = unfencedLines(fs.readFileSync(path.join(config.REPO_ROOT, rel), 'utf8'));
  let seenHeading = false;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      seenHeading = true;
      headings++;
      const parts = line.split(' — ');
      if (parts.length === 2) {
        const verdict = parts[1].split(' ')[0];
        if (verdict in verdictTotals) verdictTotals[verdict]++;
      }
    } else if (!seenHeading && line.trim() === 'Run: full monthly suite') {
      fullSuite.push(path.posix.basename(rel, '.md'));
    }
  }
}

record('result files = dated *.md on disk', api.suite.resultFiles === dated.length, `${api.suite.resultFiles} reported / ${dated.length} on disk`);

const runsInRows = api.evals.reduce((n, e) => n + e.runs.length, 0);
record('suite.runs = sum of per-eval runs', api.suite.runs === runsInRows, `${api.suite.runs} / ${runsInRows}`);

const listComplete = api.problemCount <= EVAL_PROBLEM_LIMIT;
const problemsOf = (reason) => api.problems.filter((p) => p.reason === reason);
record(
  'bad-filename problems = undated *.md on disk',
  listComplete && problemsOf('bad-filename').length === undated.length,
  listComplete
    ? `${problemsOf('bad-filename').length} reported / ${undated.length} on disk`
    : `problem list capped at ${EVAL_PROBLEM_LIMIT} of ${api.problemCount}; cannot recount`
);
const malformed = api.problems.filter((p) => p.reason === 'malformed-heading').length;
record(
  'runs + malformed headings = "## " lines outside fences',
  listComplete && api.suite.runs + malformed === headings,
  listComplete
    ? `${api.suite.runs} runs + ${malformed} malformed / ${headings} headings`
    : `problem list capped at ${EVAL_PROBLEM_LIMIT} of ${api.problemCount}; cannot recount`
);

const apiTotals = { PASS: 0, PARTIAL: 0, FAIL: 0 };
for (const e of api.evals) for (const v of Object.keys(apiTotals)) apiTotals[v] += e.counts[v];
if (malformed === 0 && listComplete) {
  record(
    'per-verdict totals match an independent split on " — "',
    JSON.stringify(apiTotals) === JSON.stringify(verdictTotals),
    `PASS ${apiTotals.PASS} · PARTIAL ${apiTotals.PARTIAL} · FAIL ${apiTotals.FAIL}`
  );
} else {
  console.log(`– per-verdict recount skipped: ${malformed} malformed heading(s) on record`);
}

const expectedFull = fullSuite.sort().at(-1) ?? null;
record(
  'last full-suite run = newest dated file with the full-suite line',
  api.suite.lastFullSuiteDate === expectedFull,
  `${api.suite.lastFullSuiteDate ?? 'none'} / ${expectedFull ?? 'none'}`
);

// ---- cases/ ---------------------------------------------------------------
const caseFiles = walk(`${EVALS}/cases`);
const casePaths = new Set(api.evals.filter((e) => e.case).map((e) => e.case.path));
const duplicatePaths = new Set(problemsOf('duplicate-case-id').map((p) => p.path));
record(
  'every case file on disk is a case or a surfaced duplicate id',
  listComplete &&
    api.suite.cases + duplicatePaths.size === caseFiles.length &&
    caseFiles.every((p) => casePaths.has(p) || duplicatePaths.has(p)),
  `${api.suite.cases} cases + ${duplicatePaths.size} duplicate ids / ${caseFiles.length} on disk`
);

const withRuns = new Set(api.evals.filter((e) => e.runs.length).map((e) => e.id));
record(
  'no "never run" case has a recorded run',
  api.suite.neverRun.every((id) => !withRuns.has(id)),
  `${api.suite.neverRun.length} never run · ${api.suite.withoutCase.length} with runs but no case page`
);

const verdictsClosed = api.evals.every((e) => e.runs.every((r) => r.verdict in apiTotals));
record('every verdict is PASS | PARTIAL | FAIL', verdictsClosed);

// Information, not an assertion: lint itself is the format gate.
console.log(`– problems on record: ${api.problemCount}`);
console.log(
  `  suite: ${api.suite.cases} cases · ${api.suite.resultFiles} result files · ${api.suite.runs} runs · ` +
    `${api.suite.neverFullSuite ? 'no full-suite run recorded' : `last full suite ${api.suite.ageDays} days old`}${api.suite.due ? ' (due)' : ''}`
);

if (failed) {
  console.log(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll eval checks passed.');
