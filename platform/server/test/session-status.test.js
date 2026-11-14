import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { captureAgeDays } from '../src/captures.js';
import {
  GIT_QUERIES,
  NOT_CHECKED,
  computeSessionStatus,
  gitChildEnv,
  formatCaptureLines,
  formatGitLine,
  formatMaintenanceLine,
  githookNote,
  hostNote,
} from '../src/sessionStatus.js';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';

/**
 * Session Status: the console's port of the memory repo's
 * `scripts/aos_status.py` (invariant 8). The expected strings below are the
 * script's own output for the same synthetic trees — a wording drift on
 * either side fails here (and `npm run check:session-status` against the
 * live repo). Everything is synthetic; hostnames are `example-host`.
 */

// Hermetic git: no user/system config (a global core.hooksPath or fsmonitor
// would otherwise leak into the githook / read-only assertions). The console's
// git child gets only an env allowlist (HOME, not GIT_CONFIG_*), so HOME
// points at an empty directory too.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), 'aos-session-home-'));

const HAS_GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const gitTest = (name, fn) =>
  test(name, HAS_GIT ? {} : { skip: 'git is not installed' }, fn);

const now = new Date('2026-11-13T12:00:00');
const tmpDirs = [];

async function tmpDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function write(root, rel, content) {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

function git(cwd, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

/** A synthetic memory tree (not a git repo unless `gitInit`). */
async function memoryTree({ gitInit = false } = {}) {
  const root = await tmpDir('aos-session-status-');
  await write(root, 'wiki/index.md', '# Index\n');
  await write(
    root,
    'wiki/log.md',
    [
      '# Activity Log',
      '',
      '## [2026-11-12] lint | fix a broken link', // a lint entry, not a pass: must not reset it
      '- not a pass.',
      '## [2026-11-12] ingest | file the evidenced capture',
      '- filed `raw/p/examples/b.md`.',
      '## [2026-11-10] lint | maintenance pass',
      '- weekly pass.',
      '',
    ].join('\n')
  );
  await write(root, 'raw/p/examples/a-2026-11-04.md', '---\ntitle: x\n---\n# a\n\nStatus: Draft\n');
  await write(root, 'raw/p/examples/c.md', '---\nknowledge_intake_date: "2026-11-08"\n---\n# c\n\nStatus: Draft\n');
  await write(root, 'raw/p/examples/b.md', '# b\n\nStatus: Ingested\n');
  await write(root, 'raw/p/examples/h.md', '---\nknowledge_intake_date: 2026-10-24\n---\n# h\n\nStatus: Draft\n');
  await write(root, 'scripts/capture-holds.txt', 'raw/p/examples/h.md  # waiting on owner\n');
  await write(root, 'wiki/agentic-os-locations.md', '# Locations\n\n### Example-Host (vps)\n');
  if (gitInit) {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
  }
  return root;
}

const status = (root, opts = {}) =>
  computeSessionStatus({ REPO_ROOT: root }, { now, hostname: 'example-host', ...opts });

after(async () => {
  await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  rmSync(process.env.HOME, { recursive: true, force: true });
});

// ---------- captureAgeDays (_capture_age) ----------

test('captureAgeDays: knowledge_intake_date, quoted or bare, wins over the file name', () => {
  assert.equal(captureAgeDays('---\nknowledge_intake_date: 2026-11-01\n---\n', 'raw/a-2026-10-01.md', '2026-11-13'), 12);
  assert.equal(captureAgeDays("---\nknowledge_intake_date: '2026-11-03'\n---\n", 'raw/a.md', '2026-11-13'), 10);
  assert.equal(captureAgeDays('---\r\nknowledge_intake_date: "2026-11-05"\r\n---\r\n', 'raw/a.md', '2026-11-13'), 8);
});

test('captureAgeDays: an invalid shape or an unreal day falls back to the file name', () => {
  assert.equal(captureAgeDays('---\nknowledge_intake_date: 2026-1-5\n---\n', 'raw/x/n-2026-11-03.md', '2026-11-13'), 10);
  assert.equal(captureAgeDays('---\nknowledge_intake_date: 2026-02-30\n---\n', 'raw/x/n-2026-11-03.md', '2026-11-13'), 10);
  // Outside a frontmatter block the key is not read.
  assert.equal(captureAgeDays('knowledge_intake_date: 2026-11-01\n', 'raw/x/n-2026-11-03.md', '2026-11-13'), 10);
});

test('captureAgeDays: neither a valid intake date nor a dated file name → null (never mtime)', () => {
  assert.equal(captureAgeDays('# no frontmatter\n', 'raw/x/notes.md', '2026-11-13'), null);
  assert.equal(captureAgeDays('', 'raw/x/n-2026-02-30.md', '2026-11-13'), null);
  assert.equal(captureAgeDays('', 'raw/2026-11-01/notes.md', '2026-11-13'), null); // a dated folder is not a dated name
});

// ---------- parity strings: the formatters (the test that catches drift) ----------

test('maintenance line: every aos_status.py branch, byte for byte', () => {
  const m = (state, ageDays, lastPass = '2026-11-10', reason = null) => formatMaintenanceLine({ state, ageDays, lastPass, reason });
  assert.equal(m('ok', 3), 'maintenance pass: ok — last pass 2026-11-10 (3d ago)');
  assert.equal(m('due', 7), 'maintenance pass: DUE — last pass 2026-11-10 (7d ago); run the maintenance pass');
  assert.equal(m('overdue', 10), 'maintenance pass: OVERDUE — last pass 2026-11-10 (10d ago); run the maintenance pass');
  assert.equal(
    m('due', null, null, 'no-pass'),
    'maintenance pass: DUE — no `lint | maintenance pass` entry in the log; run the maintenance pass (/aos-wiki-lint first)'
  );
  assert.equal(
    m('unknown', null, null, 'no-log'),
    'maintenance pass: no wiki/log.md — cannot tell when the last pass ran'
  );
});

test('capture lines: queue, ingested since the pass, and the on-hold line', () => {
  const base = { state: 'ok', draftN: 0, oldestDraftDays: null, ingestedSincePass: 1, lastPass: '2026-11-10', heldN: 0, oldestHeldDays: null, holdReasons: [] };
  assert.deepEqual(formatCaptureLines(base), ['captures: no Draft waiting; 1 ingested since the last pass (2026-11-10)']);
  assert.deepEqual(formatCaptureLines({ ...base, draftN: 2, oldestDraftDays: 9 }), [
    'captures: 2 Draft waiting for /aos-ingest, oldest 9d; 1 ingested since the last pass (2026-11-10)',
  ]);
  assert.deepEqual(formatCaptureLines({ ...base, draftN: 1, ingestedSincePass: null, lastPass: null }), [
    'captures: 1 Draft waiting for /aos-ingest; ingested since the last pass: n/a (no maintenance pass on record)',
  ]);
  assert.deepEqual(formatCaptureLines({ ...base, heldN: 1, oldestHeldDays: 20, holdReasons: ['waiting on owner'] }), [
    'captures: no Draft waiting; 1 ingested since the last pass (2026-11-10)',
    'on hold: 1 Draft parked by scripts/capture-holds.txt, oldest 20d — waiting on owner (not overdue)',
  ]);
  assert.equal(
    formatCaptureLines({ ...base, heldN: 2, holdReasons: [] })[1],
    'on hold: 2 Draft parked by scripts/capture-holds.txt (not overdue)'
  );
});

test('git line: all four aos_status.py shapes plus the unavailable notes', () => {
  const ok = { state: 'ok', branch: 'main', upstream: 'origin/main', ahead: 1, behind: 2, dirtyN: 0 };
  assert.equal(formatGitLine(ok), 'git: main ahead 1 / behind 2 vs origin/main (as of last fetch), clean');
  assert.equal(formatGitLine({ ...ok, ahead: null, behind: null, dirtyN: 3 }), 'git: main, ahead/behind unknown, 3 dirty file(s)');
  assert.equal(
    formatGitLine({ ...ok, branch: null, upstream: null, ahead: null, behind: null }),
    'git: detached HEAD, no upstream (no remote tracking branch), clean'
  );
  assert.equal(formatGitLine({ state: 'unavailable', reason: 'not-a-repository' }), 'git: not a git repository — git state unknown');
  assert.equal(formatGitLine({ state: 'unavailable', reason: 'git-not-installed' }), 'git: not installed — git state unknown');
  assert.equal(formatGitLine({ state: 'unavailable', reason: 'timeout' }), 'git: skipped (time budget)');
});

test('setup notes: githook and host, as the setup: line spells them', () => {
  assert.equal(githookNote({ state: 'ok' }), null);
  assert.equal(githookNote({ state: 'missing', fix: 'python3 scripts/install-git-hooks.py' }), 'githook missing (python3 scripts/install-git-hooks.py)');
  assert.equal(githookNote({ state: 'unknown', reason: 'git-not-installed' }), 'githook unknown (git missing)');
  assert.equal(hostNote({ state: 'ok', name: 'example-host' }), null);
  assert.equal(hostNote({ state: 'missing', name: 'example-host' }), "host 'example-host' not in wiki/agentic-os-locations.md");
  assert.equal(hostNote({ state: 'unknown', name: 'example-host', reason: 'no-locations-page' }), 'locations page missing');
});

// ---------- end to end on a synthetic tree ----------

test('a synthetic tree reads exactly as aos_status.py prints it', async () => {
  const root = await memoryTree();
  const s = await status(root, { runGit: async () => ({ code: 128, stdout: '' }) });
  assert.deepEqual(s.lines, [
    'maintenance pass: ok — last pass 2026-11-10 (3d ago)', // the newer plain `lint` entry does not reset it
    'captures: 2 Draft waiting for /aos-ingest, oldest 9d; 1 ingested since the last pass (2026-11-10)',
    'on hold: 1 Draft parked by scripts/capture-holds.txt, oldest 20d — waiting on owner (not overdue)',
    'git: not a git repository — git state unknown',
  ]);
  assert.deepEqual(s.maintenance, { state: 'ok', lastPass: '2026-11-10', ageDays: 3, reason: null });
  assert.equal(s.captures.draftN, 2);
  assert.equal(s.captures.oldestDraftDays, 9);
  assert.equal(s.captures.heldN, 1);
  assert.equal(s.captures.oldestHeldDays, 20);
  assert.deepEqual(s.captures.holdReasons, ['waiting on owner']);
  assert.equal(s.today, '2026-11-13');
  assert.equal(s.mirrors, 'scripts/aos_status.py');
});

test('maintenance: DUE at 7 days, OVERDUE at 10, DUE with no pass, a note with no wiki/log.md', async () => {
  const root = await memoryTree();
  const runGit = async () => ({ code: 128, stdout: '' });
  assert.equal((await status(root, { runGit, now: new Date('2026-11-17T09:00:00') })).maintenance.state, 'due');
  assert.equal((await status(root, { runGit, now: new Date('2026-11-20T09:00:00') })).maintenance.state, 'overdue');

  await write(root, 'wiki/log.md', '# Activity Log\n\n## [2026-11-12] lint | fix a broken link\n');
  const noPass = await status(root, { runGit });
  assert.deepEqual(noPass.maintenance, { state: 'due', lastPass: null, ageDays: null, reason: 'no-pass' });
  assert.equal(noPass.captures.ingestedSincePass, null);
  assert.match(noPass.lines[1], /n\/a \(no maintenance pass on record\)$/);

  await fs.rm(path.join(root, 'wiki/log.md'));
  const noLog = await status(root, { runGit });
  assert.deepEqual(noLog.maintenance, { state: 'unknown', lastPass: null, ageDays: null, reason: 'no-log' });
});

test('lint deps and skills sync are always not-checked with a reason and a command, never ok', async () => {
  const s = await status(await memoryTree(), { runGit: async () => ({ code: 128, stdout: '' }) });
  for (const key of ['lintDeps', 'skills']) {
    assert.equal(s.setup[key].state, 'not-checked');
    assert.ok(s.setup[key].reason);
    assert.match(s.setup[key].command, /^python3 scripts\//);
    assert.deepEqual(s.setup[key], NOT_CHECKED[key]);
  }
});

// ---------- host row (host_note) ----------

test('host row: exact, case-insensitive and `(` forms match; a longer name does not; no page → unknown', async () => {
  const root = await memoryTree();
  const runGit = async () => ({ code: 128, stdout: '' });
  const host = async (body, hostname = 'example-host') => {
    await write(root, 'wiki/agentic-os-locations.md', body);
    return (await status(root, { runGit, hostname })).setup.host;
  };
  assert.equal((await host('### example-host\n')).state, 'ok');
  assert.equal((await host('### EXAMPLE-HOST — laptop\n')).state, 'ok');
  assert.equal((await host('# L\n\n### example-host(vps)\n')).state, 'ok');
  assert.equal((await host('### example-host2\n')).state, 'missing');
  assert.equal((await host('#### example-host\n')).state, 'missing');
  assert.equal((await host('### a.b\n', 'a.b')).state, 'ok');
  assert.equal((await host('### axb\n', 'a.b')).state, 'missing'); // the hostname is escaped, not a pattern
  await fs.rm(path.join(root, 'wiki/agentic-os-locations.md'));
  assert.deepEqual((await status(root, { runGit })).setup.host, { state: 'unknown', name: 'example-host', reason: 'no-locations-page' });
});

// ---------- git, against real repositories ----------

gitTest('git: not a repository', async () => {
  const s = await status(await memoryTree());
  assert.deepEqual(s.git, { state: 'unavailable', reason: 'not-a-repository' });
  assert.equal(s.setup.githook.state, 'missing');
});

gitTest('git: no upstream; the dirty count counts untracked and modified files', async () => {
  const root = await memoryTree({ gitInit: true });
  const clean = await status(root);
  assert.deepEqual(clean.git, { state: 'ok', branch: 'main', upstream: null, ahead: null, behind: null, dirtyN: 0 });
  assert.equal(clean.lines.at(-1), 'git: main, no upstream (no remote tracking branch), clean');

  await write(root, 'wiki/index.md', '# Index (edited)\n');
  await write(root, 'raw/p/new.md', '# untracked\n');
  const dirty = await status(root);
  assert.equal(dirty.git.dirtyN, 2);
  assert.equal(dirty.lines.at(-1), 'git: main, no upstream (no remote tracking branch), 2 dirty file(s)');
});

gitTest('git: ahead 1 / behind 1 against a local bare remote (as of the last fetch)', async () => {
  const bare = await tmpDir('aos-session-bare-');
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const root = await memoryTree({ gitInit: true });
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', '-u', 'origin', 'main');

  const other = await tmpDir('aos-session-other-');
  git(other, 'clone', '-q', bare, '.');
  await write(other, 'wiki/other.md', '# other\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', 'theirs');
  git(other, 'push', '-q');

  await write(root, 'wiki/mine.md', '# mine\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'mine');
  const beforeFetch = await status(root);
  assert.equal(beforeFetch.git.ahead, 1);
  assert.equal(beforeFetch.git.behind, 0); // never fetches on its own

  git(root, 'fetch', '-q');
  const s = await status(root);
  assert.deepEqual(s.git, { state: 'ok', branch: 'main', upstream: 'origin/main', ahead: 1, behind: 1, dirtyN: 0 });
  assert.equal(s.lines.at(-1), 'git: main ahead 1 / behind 1 vs origin/main (as of last fetch), clean');
});

gitTest('git: a detached HEAD has no branch', async () => {
  const root = await memoryTree({ gitInit: true });
  git(root, 'checkout', '-q', '--detach');
  const s = await status(root);
  assert.equal(s.git.branch, null);
  assert.equal(s.lines.at(-1), 'git: detached HEAD, no upstream (no remote tracking branch), clean');
});

gitTest('githook: ok when core.hooksPath is scripts/githooks, else missing with the fix', async () => {
  const root = await memoryTree({ gitInit: true });
  assert.deepEqual((await status(root)).setup.githook, { state: 'missing', fix: 'python3 scripts/install-git-hooks.py', reason: null });
  git(root, 'config', 'core.hooksPath', 'scripts/githooks');
  assert.deepEqual((await status(root)).setup.githook, { state: 'ok', fix: null, reason: null });
});

gitTest('safety: reading the status leaves the index and the worktree untouched', async () => {
  const root = await memoryTree({ gitInit: true });
  // Touch a tracked file (same content) so a plain `git status` would refresh the index.
  const future = new Date(Date.now() + 60_000);
  await fs.utimes(path.join(root, 'wiki/index.md'), future, future);
  const porcelain = git(root, '--no-optional-locks', 'status', '--porcelain');
  const indexBefore = (await fs.stat(path.join(root, '.git/index'))).mtimeMs;
  await status(root);
  await status(root);
  assert.equal((await fs.stat(path.join(root, '.git/index'))).mtimeMs, indexBefore);
  assert.equal(git(root, '--no-optional-locks', 'status', '--porcelain'), porcelain);
});

// ---------- git hardening: the reasons the GET-path subprocess is acceptable ----------

const SECRETS = {
  FIREFLY_TOKEN: 'sentinel-firefly-token',
  PROXY_SECRET: 'sentinel-proxy-secret',
  HEALTH_REPO_ROOT: '/sentinel/health-root',
  FIREFLY_URL: 'http://127.0.0.1:1/sentinel',
};

/** Run `fn` with extra variables in process.env, restoring them afterwards. */
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('gitChildEnv is an allowlist: PATH/HOME/LANG/LC_*/TZ + the GIT_* hardening, nothing else', () => {
  const env = gitChildEnv(
    {
      ...SECRETS,
      PATH: '/usr/bin',
      HOME: '/home/example',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: 'UTC',
      GIT_DIR: '/elsewhere/.git',
      GIT_WORK_TREE: '/elsewhere',
      SYSTEMROOT: 'C:\\Windows',
      NODE_OPTIONS: '--require /x.js',
    },
    'linux'
  );
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    HOME: '/home/example',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  });
  assert.equal(gitChildEnv({ SYSTEMROOT: 'C:\\Windows' }, 'win32').SYSTEMROOT, 'C:\\Windows');
});

gitTest('the git child sees no secret: a clean filter that dumps its env finds none', async () => {
  const root = await memoryTree({ gitInit: true });
  const dump = path.join(await tmpDir('aos-session-envdump-'), 'env.txt');
  // A clean filter is a helper the clone's own config starts during `git status`.
  git(root, 'config', 'filter.dump.clean', `env > '${dump}'; cat`);
  await write(root, '.gitattributes', '*.md filter=dump\n');
  git(root, 'add', '.gitattributes');
  git(root, 'commit', '-q', '-m', 'attributes');
  // Stat-dirty (same content, new mtime) so status must re-hash through the filter.
  const future = new Date(Date.now() + 60_000);
  await fs.utimes(path.join(root, 'wiki/index.md'), future, future);

  const s = await withEnv(SECRETS, () => status(root));
  assert.equal(s.git.state, 'ok');
  const seen = await fs.readFile(dump, 'utf8'); // the filter did run in the child
  for (const [name, value] of Object.entries(SECRETS)) {
    assert.ok(!seen.includes(name), `${name} reached the git child`);
    assert.ok(!seen.includes(value), `the value of ${name} reached the git child`);
  }
  assert.match(seen, /^GIT_TERMINAL_PROMPT=0$/m);
});

gitTest('core.fsmonitor=false: a repo-configured fsmonitor hook never runs', async () => {
  const root = await memoryTree({ gitInit: true });
  const dir = await tmpDir('aos-session-fsmonitor-');
  const marker = path.join(dir, 'ran');
  const hook = path.join(dir, 'fsmonitor.sh');
  await fs.writeFile(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  git(root, 'config', 'core.fsmonitor', hook);

  git(root, 'status', '--porcelain'); // control: plain git runs the hook
  await fs.access(marker);
  await fs.rm(marker);

  await status(root);
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
});

gitTest('GIT_DIR / GIT_WORK_TREE in the server env cannot point git away from REPO_ROOT', async () => {
  const root = await memoryTree({ gitInit: true });
  const other = await memoryTree({ gitInit: true });
  git(other, 'checkout', '-q', '-b', 'elsewhere');
  await write(other, 'wiki/dirty.md', '# dirty\n');

  const s = await withEnv({ GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other }, () => status(root));
  assert.deepEqual(s.git, { state: 'ok', branch: 'main', upstream: null, ahead: null, behind: null, dirtyN: 0 });
});

// ---------- git, against fake runners ----------

test('safety: every git argv is a frozen GIT_QUERIES member; none fetches, pulls or pushes', async () => {
  const seen = [];
  const answers = new Map([
    [GIT_QUERIES.gitDir, { code: 0, stdout: '.git\n' }],
    [GIT_QUERIES.branch, { code: 0, stdout: 'main\n' }],
    [GIT_QUERIES.status, { code: 0, stdout: ' M wiki/index.md\n?? raw/new.md\n' }],
    [GIT_QUERIES.upstream, { code: 0, stdout: 'origin/main\n' }],
    [GIT_QUERIES.counts, { code: 0, stdout: '4\t2\n' }],
    [GIT_QUERIES.hooksPath, { code: 0, stdout: 'scripts/githooks\n' }],
  ]);
  const runGit = async (args, opts) => {
    seen.push({ args, opts });
    return answers.get(args);
  };
  const root = await memoryTree();
  const s = await status(root, { runGit });
  const members = Object.values(GIT_QUERIES);
  assert.equal(seen.length, 6);
  for (const { args, opts } of seen) {
    assert.ok(members.includes(args), `unexpected argv ${args.join(' ')}`);
    assert.ok(Object.isFrozen(args));
    assert.ok(!args.some((a) => /^(fetch|pull|push)$/.test(a)));
    assert.equal(opts.cwd, root);
    assert.ok(opts.timeoutMs > 0 && opts.timeoutMs <= 1600);
  }
  assert.deepEqual(s.git, { state: 'ok', branch: 'main', upstream: 'origin/main', ahead: 2, behind: 4, dirtyN: 2 });
  assert.equal(s.setup.githook.state, 'ok');
});

test('git not installed → git-not-installed and githook unknown, never zeros', async () => {
  const runGit = async () => {
    throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
  };
  const s = await status(await memoryTree(), { runGit });
  assert.deepEqual(s.git, { state: 'unavailable', reason: 'git-not-installed' });
  assert.deepEqual(s.setup.githook, { state: 'unknown', fix: null, reason: 'git-not-installed' });
  assert.equal(s.lines.at(-1), 'git: not installed — git state unknown');
});

test('a git call that never answers times out within the budget', async () => {
  const started = Date.now();
  const s = await status(await memoryTree(), { runGit: () => new Promise(() => {}), budgetMs: 200 });
  assert.deepEqual(s.git, { state: 'unavailable', reason: 'timeout' });
  assert.equal(s.setup.githook.reason, 'timeout');
  assert.equal(s.lines.at(-1), 'git: skipped (time budget)');
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
});

test('unparseable ahead/behind counts → unknown, not zero', async () => {
  const runGit = async (args) =>
    args === GIT_QUERIES.counts
      ? { code: 0, stdout: 'garbage\n' }
      : args === GIT_QUERIES.branch
        ? { code: 0, stdout: 'main\n' }
        : { code: 0, stdout: args === GIT_QUERIES.upstream ? 'origin/main\n' : '' };
  const s = await status(await memoryTree(), { runGit });
  assert.deepEqual(s.git, { state: 'ok', branch: 'main', upstream: 'origin/main', ahead: null, behind: null, dirtyN: 0 });
  assert.equal(s.lines.at(-1), 'git: main, ahead/behind unknown, clean');
});

// ---------- per-block guards ----------

test('a throwing git runner leaves maintenance, captures and host intact', async () => {
  const s = await status(await memoryTree(), {
    runGit: async () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual(s.git, { state: 'unavailable', reason: 'error' });
  assert.equal(s.maintenance.state, 'ok');
  assert.equal(s.captures.draftN, 2);
  assert.equal(s.setup.host.state, 'ok');
});

test(
  'an unreadable Draft makes captures unavailable and leaves the other blocks intact',
  { skip: process.getuid?.() === 0 ? 'root ignores file modes' : false },
  async () => {
    const root = await memoryTree();
    await write(root, 'raw/p/examples/locked-2026-11-01.md', '# locked\n\nStatus: Draft\n');
    await fs.chmod(path.join(root, 'raw/p/examples/locked-2026-11-01.md'), 0o000);
    try {
      const s = await status(root, { runGit: async () => ({ code: 128, stdout: '' }) });
      assert.deepEqual(s.captures, { state: 'unavailable', reason: 'error' });
      assert.deepEqual(s.lines.slice(1, 2), ['captures: unavailable']);
      assert.equal(s.maintenance.state, 'ok');
      assert.equal(s.setup.host.state, 'ok');
    } finally {
      await fs.chmod(path.join(root, 'raw/p/examples/locked-2026-11-01.md'), 0o644);
    }
  }
);

// ---------- the route ----------

let routeRoot;
let app;
before(async () => {
  routeRoot = await memoryTree();
  app = createApp(createConfig({ REPO_ROOT: routeRoot }));
});

test('GET /api/session-status: 200 with every block, no absolute path, no raw body text', async () => {
  const res = await request(app).get('/api/session-status').set('Host', '127.0.0.1:3001');
  assert.equal(res.status, 200);
  for (const key of ['maintenance', 'captures', 'git', 'setup', 'lines', 'mirrors', 'generatedAt']) {
    assert.ok(key in res.body, `missing ${key}`);
  }
  assert.deepEqual(Object.keys(res.body.setup).sort(), ['githook', 'host', 'lintDeps', 'skills']);
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes(routeRoot), 'payload leaks REPO_ROOT');
  assert.ok(!text.includes(os.tmpdir()), 'payload leaks an absolute path');
  for (const body of ['# a', 'Status: Draft', 'weekly pass', 'Example-Host (vps)']) {
    assert.ok(!text.includes(body), `payload leaks body text ${body}`);
  }
});

test('/api/session-status sits behind the Host/Origin guard', async () => {
  const badHost = await request(app).get('/api/session-status').set('Host', 'evil.example');
  assert.equal(badHost.status, 403);
  const crossOrigin = await request(app)
    .get('/api/session-status')
    .set('Host', '127.0.0.1:3001')
    .set('Origin', 'http://evil.example');
  assert.equal(crossOrigin.status, 403);
});

test('/api/session-status is GET only (other methods fall through to the 404)', async () => {
  const res = await request(app)
    .post('/api/session-status')
    .set('Host', '127.0.0.1:3001')
    .set('Origin', 'http://127.0.0.1:3001');
  assert.equal(res.status, 404);
});
