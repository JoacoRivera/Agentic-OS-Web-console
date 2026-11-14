import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { collectPages } from './metrics.js';
import {
  HOLDS_FILE,
  MAINTENANCE_DUE_DAYS,
  MAINTENANCE_OVERDUE_DAYS,
  captureAgeDays,
  classifyCaptures,
  daysBetween,
  ingestedSincePass,
  lastMaintenancePass,
  readLogEntries,
} from './captures.js';

/**
 * Session Status — the console's live port of the memory repo's
 * `scripts/aos_status.py` (invariant 8): maintenance pass, capture queue
 * (with the oldest age and the holds), git state of the `REPO_ROOT` clone,
 * and setup health. Maintenance and captures reuse the rules in
 * `captures.js` (one implementation, shared with `/api/metrics`); the
 * formatters below reproduce the script's text lines byte for byte so
 * `npm run check:session-status` can compare the two.
 *
 * Read-only. Two setup checks are **not ported** and are reported
 * `not-checked` with the command that does check them, never as ok:
 * the Python lint deps (a fact about the Python environment) and
 * `sync-skills.py --check --global` (it reads `skills/`, `plugins/` and
 * locations under `$HOME`, all outside the console's allowed roots).
 *
 * ## The git subprocess (ADR-0005 notes)
 *
 * This is the console's only subprocess on a GET path. It is bounded so:
 * - **Fixed argv.** The only argument vectors are the frozen `GIT_QUERIES`
 *   below; the route takes no input, so nothing from a request reaches them.
 *   `spawn('git', …, { shell: false })` — no shell, no interpolation.
 * - **Read-only.** Every query is a plumbing/porcelain *read*
 *   (`rev-parse`, `symbolic-ref`, `status --porcelain`, `rev-list --count`,
 *   `config --get`). It never fetches, pulls, pushes or writes; ahead/behind
 *   is "as of last fetch", exactly as the script says.
 * - **No index or hook side effects.** `--no-optional-locks` (and
 *   `GIT_OPTIONAL_LOCKS=0`) stop `git status` from refreshing `.git/index`;
 *   `-c core.fsmonitor=false` stops a repo-configured fsmonitor hook from
 *   running; `GIT_TERMINAL_PROMPT=0` forbids prompts; repo-locating
 *   variables (`GIT_DIR`, `GIT_WORK_TREE`, …) are scrubbed so `cwd` =
 *   `REPO_ROOT` alone decides which clone is read.
 * - **Timeout.** One shared 1600 ms budget across the calls (the script's
 *   `BUDGET_SECONDS`); a call past it is SIGKILLed and the block reports
 *   `timeout` — never a guessed value.
 * - **What leaves the server:** branch name, upstream name, three integers
 *   and whether `core.hooksPath` equals `scripts/githooks`. No path, no file
 *   name, no diff.
 */

export const MIRRORS = 'scripts/aos_status.py';
export const BUDGET_MS = 1600; // aos_status.BUDGET_SECONDS
export const HOOKS_PATH_VALUE = 'scripts/githooks';
export const LOCATIONS_PAGE = 'wiki/agentic-os-locations.md';
const MIN_REMAINING_MS = 50; // Deadline.remaining() floor (0.05 s)
const MAX_GIT_OUTPUT = 8 * 1024 * 1024;

const freeze = (argv) => Object.freeze(argv);
/** The only git argument vectors this module ever runs (after the hardening flags). */
export const GIT_QUERIES = Object.freeze({
  gitDir: freeze(['rev-parse', '--git-dir']),
  branch: freeze(['symbolic-ref', '--short', '-q', 'HEAD']),
  status: freeze(['status', '--porcelain']),
  upstream: freeze(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
  counts: freeze(['rev-list', '--left-right', '--count', '@{u}...HEAD']),
  hooksPath: freeze(['config', '--get', 'core.hooksPath']),
});
const HARDENING = Object.freeze(['--no-optional-locks', '-c', 'core.fsmonitor=false']);
const SCRUBBED_ENV = Object.freeze([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
]);

export const NOT_CHECKED = Object.freeze({
  lintDeps: Object.freeze({
    state: 'not-checked',
    reason: 'python-environment',
    command: 'python3 scripts/aos_status.py',
  }),
  skills: Object.freeze({
    state: 'not-checked',
    reason: 'reads-outside-repo-root',
    command: 'python3 scripts/sync-skills.py --check --global',
  }),
});

const codeError = (message, code) => Object.assign(new Error(message), { code });

/**
 * Run one git query in `cwd` → `{ code, stdout }`. Rejects with the spawn
 * error (`ENOENT` when git is not installed) or `ETIMEDOUT` after SIGKILL.
 */
export function defaultRunGit(args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
    for (const key of SCRUBBED_ENV) delete env[key];
    let settled = false;
    let child;
    let timer;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    try {
      child = spawn('git', [...HARDENING, ...args], {
        cwd,
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, codeError('git timed out', 'ETIMEDOUT'));
    }, timeoutMs);
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_GIT_OUTPUT) {
        child.kill('SIGKILL');
        finish(reject, codeError('git output too large', 'EOVERFLOW'));
      }
    });
    child.stderr.resume();
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => finish(resolve, { code, stdout }));
  });
}

/** The local calendar day of `now` as `YYYY-MM-DD` (the script's `date.today()`). */
export function localDay(now) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function isFile(abs) {
  try {
    return (await fs.stat(abs)).isFile();
  } catch {
    return false;
  }
}

const splitLines = (text) => text.split(/\r\n|\r|\n/);
const failureReason = (error) =>
  error?.code === 'ENOENT' ? 'git-not-installed' : error?.code === 'ETIMEDOUT' ? 'timeout' : 'error';

// ---------- maintenance pass (maintenance_line) ----------

async function maintenanceBlock(repoRoot, entries, today) {
  if (!(await isFile(path.join(repoRoot, 'wiki/log.md')))) {
    return { state: 'unknown', lastPass: null, ageDays: null, reason: 'no-log' };
  }
  const pass = lastMaintenancePass(entries);
  if (!pass) return { state: 'due', lastPass: null, ageDays: null, reason: 'no-pass' };
  const ageDays = daysBetween(pass.dateText, today);
  const state =
    ageDays >= MAINTENANCE_OVERDUE_DAYS ? 'overdue' : ageDays >= MAINTENANCE_DUE_DAYS ? 'due' : 'ok';
  return { state, lastPass: pass.dateText, ageDays, reason: null };
}

export function formatMaintenanceLine(m) {
  if (m.reason === 'no-log') return 'maintenance pass: no wiki/log.md — cannot tell when the last pass ran';
  if (m.reason === 'error') return 'maintenance pass: unavailable';
  if (m.reason === 'no-pass') {
    return (
      'maintenance pass: DUE — no `lint | maintenance pass` entry in the log; '
      + 'run the maintenance pass (/aos-wiki-lint first)'
    );
  }
  const when = `last pass ${m.lastPass} (${m.ageDays}d ago)`;
  if (m.state === 'overdue') return `maintenance pass: OVERDUE — ${when}; run the maintenance pass`;
  if (m.state === 'due') return `maintenance pass: DUE — ${when}; run the maintenance pass`;
  return `maintenance pass: ok — ${when}`;
}

// ---------- captures (capture_lines) ----------

async function oldestAge(repoRoot, items, today) {
  // A capture that cannot be read fails the whole block, as in the script.
  const ages = await Promise.all(
    items.map(async (item) =>
      captureAgeDays(await fs.readFile(path.join(repoRoot, item.path), 'utf8'), item.path, today)
    )
  );
  const known = ages.filter((age) => age !== null);
  return known.length ? Math.max(...known) : null;
}

async function capturesBlock(repoRoot, entries, today) {
  const [rawPages, wikiPages] = await Promise.all([
    collectPages(repoRoot, 'raw'),
    collectPages(repoRoot, 'wiki'),
  ]);
  const { buckets, firstIngest } = await classifyCaptures(
    repoRoot,
    rawPages.map((p) => p.path),
    wikiPages.map((p) => p.path),
    entries
  );
  const pass = lastMaintenancePass(entries);
  const holdReasons = [...new Set(buckets.onHold.map((i) => i.hold).filter(Boolean))].sort();
  return {
    state: 'ok',
    draftN: buckets.draft.length,
    oldestDraftDays: await oldestAge(repoRoot, buckets.draft, today),
    ingestedSincePass: ingestedSincePass(buckets, firstIngest, entries, pass),
    lastPass: pass?.dateText ?? null,
    heldN: buckets.onHold.length,
    oldestHeldDays: await oldestAge(repoRoot, buckets.onHold, today),
    holdReasons,
  };
}

export function formatCaptureLines(c) {
  if (c.state !== 'ok') return ['captures: unavailable'];
  const oldest = (days) => (days === null ? '' : `, oldest ${days}d`);
  const queue = c.draftN
    ? `${c.draftN} Draft waiting for /aos-ingest${oldest(c.oldestDraftDays)}`
    : 'no Draft waiting';
  const recent =
    c.ingestedSincePass === null
      ? 'ingested since the last pass: n/a (no maintenance pass on record)'
      : `${c.ingestedSincePass} ingested since the last pass (${c.lastPass})`;
  const lines = [`captures: ${queue}; ${recent}`];
  if (c.heldN) {
    const why = c.holdReasons.length ? ` — ${c.holdReasons.join('; ')}` : '';
    lines.push(
      `on hold: ${c.heldN} Draft parked by ${HOLDS_FILE}${oldest(c.oldestHeldDays)}${why} (not overdue)`
    );
  }
  return lines;
}

// ---------- git (git_line) and the githook (githook_note) ----------

async function gitBlock(git) {
  try {
    const repo = await git(GIT_QUERIES.gitDir);
    if (repo.code !== 0) return { state: 'unavailable', reason: 'not-a-repository' };
    // symbolic-ref also works on an unborn branch; a detached HEAD has none.
    const branch = (await git(GIT_QUERIES.branch)).stdout.trim() || null;
    const status = await git(GIT_QUERIES.status);
    const dirtyN = splitLines(status.stdout).filter((l) => l.trim()).length;
    const upstream = await git(GIT_QUERIES.upstream);
    if (upstream.code !== 0) {
      return { state: 'ok', branch, upstream: null, ahead: null, behind: null, dirtyN };
    }
    const counts = (await git(GIT_QUERIES.counts)).stdout.trim().split(/\s+/);
    const known = counts.length === 2 && counts.every((n) => /^\d+$/.test(n));
    return {
      state: 'ok',
      branch,
      upstream: upstream.stdout.trim(),
      ahead: known ? Number(counts[1]) : null,
      behind: known ? Number(counts[0]) : null,
      dirtyN,
    };
  } catch (error) {
    return { state: 'unavailable', reason: failureReason(error) };
  }
}

export function formatGitLine(g) {
  if (g.state !== 'ok') {
    return {
      'git-not-installed': 'git: not installed — git state unknown',
      'not-a-repository': 'git: not a git repository — git state unknown',
      timeout: 'git: skipped (time budget)',
    }[g.reason] ?? 'git: unavailable';
  }
  const branch = g.branch ?? 'detached HEAD';
  const dirty = g.dirtyN ? `${g.dirtyN} dirty file(s)` : 'clean';
  if (g.upstream === null) return `git: ${branch}, no upstream (no remote tracking branch), ${dirty}`;
  if (g.ahead === null) return `git: ${branch}, ahead/behind unknown, ${dirty}`;
  return `git: ${branch} ahead ${g.ahead} / behind ${g.behind} vs ${g.upstream} (as of last fetch), ${dirty}`;
}

async function githookBlock(git) {
  try {
    const proc = await git(GIT_QUERIES.hooksPath);
    return proc.stdout.trim() === HOOKS_PATH_VALUE
      ? { state: 'ok', fix: null, reason: null }
      : { state: 'missing', fix: 'python3 scripts/install-git-hooks.py', reason: null };
  } catch (error) {
    return { state: 'unknown', fix: null, reason: failureReason(error) };
  }
}

/** The script's githook note: null when fine. */
export function githookNote(h) {
  if (h.state === 'ok') return null;
  if (h.state === 'missing') return `githook missing (${h.fix})`;
  if (h.reason === 'git-not-installed') return 'githook unknown (git missing)';
  if (h.reason === 'timeout') return 'githook: skipped (time budget)';
  return 'githook: unavailable';
}

// ---------- this host's row (host_note) ----------

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function hostBlock(repoRoot, name) {
  const page = path.join(repoRoot, LOCATIONS_PAGE);
  if (!(await isFile(page))) return { state: 'unknown', name, reason: 'no-locations-page' };
  try {
    const text = (await fs.readFile(page, 'utf8')).replace(/\r\n?/g, '\n');
    const row = new RegExp(`^### ${escapeRe(name)}(\\s|\\(|$)`, 'mi');
    return row.test(text) ? { state: 'ok', name, reason: null } : { state: 'missing', name, reason: null };
  } catch {
    return { state: 'unknown', name, reason: 'error' };
  }
}

/** The script's host note: null when fine. */
export function hostNote(h) {
  if (h.state === 'ok') return null;
  if (h.reason === 'no-locations-page') return 'locations page missing';
  if (h.state === 'missing') return `host '${h.name}' not in ${LOCATIONS_PAGE}`;
  return `host ${h.name}: unavailable`;
}

// ---------- assembly ----------

function defaultHostname() {
  try {
    return os.hostname().split('.')[0] || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Run one block; a failure yields that block's unknown state, never a 500 or a zero. */
async function guard(fn, fallback) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export async function computeSessionStatus(
  config,
  { now = new Date(), hostname = defaultHostname(), runGit = defaultRunGit, budgetMs = BUDGET_MS } = {}
) {
  const repoRoot = config.REPO_ROOT;
  const today = localDay(now);
  const end = performance.now() + budgetMs;
  const git = async (args) => {
    const timeoutMs = Math.max(MIN_REMAINING_MS, end - performance.now());
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(codeError('git timed out', 'ETIMEDOUT')), timeoutMs);
    });
    try {
      return await Promise.race([runGit(args, { cwd: repoRoot, timeoutMs }), deadline]);
    } finally {
      clearTimeout(timer);
    }
  };

  const entriesP = readLogEntries(repoRoot);
  const unknownMaintenance = { state: 'unknown', lastPass: null, ageDays: null, reason: 'error' };
  const [maintenance, captures, gitState, host] = await Promise.all([
    guard(async () => maintenanceBlock(repoRoot, await entriesP, today), unknownMaintenance),
    guard(async () => capturesBlock(repoRoot, await entriesP, today), { state: 'unavailable', reason: 'error' }),
    // githook after git, sharing the budget, as the script orders them.
    (async () => {
      const g = await gitBlock(git);
      return { git: g, githook: await githookBlock(git) };
    })(),
    guard(() => hostBlock(repoRoot, hostname), { state: 'unknown', name: hostname, reason: 'error' }),
  ]);

  return {
    today,
    maintenance,
    captures,
    git: gitState.git,
    setup: {
      githook: gitState.githook,
      host,
      lintDeps: { ...NOT_CHECKED.lintDeps },
      skills: { ...NOT_CHECKED.skills },
    },
    lines: [formatMaintenanceLine(maintenance), ...formatCaptureLines(captures), formatGitLine(gitState.git)],
    mirrors: MIRRORS,
    generatedAt: now.toISOString(),
  };
}
