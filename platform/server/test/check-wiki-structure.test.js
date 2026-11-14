import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WRAPPER_FAILURE_EXIT,
  lintEnv,
  resolveLintCommand,
} from '../../scripts/check-wiki-structure.mjs';

/**
 * check:wiki-structure wrapper (ADR-0001 amendment, 2026-11-14): fixed argv,
 * minimal environment, exit codes passed through. The integration half runs
 * the real wrapper against a synthetic stub lint (fixtures/wiki-lint-stub).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = path.resolve(__dirname, '../../scripts/check-wiki-structure.mjs');
const STUB = path.join(__dirname, 'fixtures', 'wiki-lint-stub', 'scripts', 'wiki-lint.py');
const hasPython = spawnSync('python3', ['--version']).status === 0;

test('lintEnv keeps only the allowlisted keys and disables bytecode writes', () => {
  const env = lintEnv({
    PATH: '/usr/bin',
    HOME: '/home/someone',
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    FIREFLY_TOKEN: 'secret-token',
    FIREFLY_URL: 'http://127.0.0.1:8081',
    PROXY_SECRET: 'x'.repeat(40),
    PROXY_HOSTNAME: 'console.example',
    REPO_ROOT: '/repo',
    PYTHONPATH: '/evil',
    NODE_OPTIONS: '--require /evil.js',
  });
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    HOME: '/home/someone',
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    PYTHONDONTWRITEBYTECODE: '1',
  });
});

test('resolveLintCommand prefers the repo venv, else python3, and never adds arguments', () => {
  const root = '/fixture/repo';
  const withVenv = resolveLintCommand(root, { exists: (p) => p === path.join(root, '.venv/bin/python') });
  assert.equal(withVenv.python, path.join(root, '.venv/bin/python'));
  assert.deepEqual(withVenv.argv, [path.join(root, 'scripts/wiki-lint.py')]);
  assert.equal(withVenv.cwd, root);

  const without = resolveLintCommand(root, { exists: () => false });
  assert.equal(without.python, 'python3');
  assert.deepEqual(without.argv, [path.join(root, 'scripts/wiki-lint.py')]);
});

async function stubRepo(exitCode) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aos-wiki-lint-'));
  await fs.mkdir(path.join(dir, 'scripts'));
  await fs.copyFile(STUB, path.join(dir, 'scripts', 'wiki-lint.py'));
  if (exitCode !== undefined) {
    await fs.writeFile(path.join(dir, 'scripts', 'stub-exit-code'), String(exitCode));
  }
  return dir;
}

function runWrapper(repoRoot, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WRAPPER], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, REPO_ROOT: repoRoot, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

const line = (stdout, tag) => stdout.split('\n').find((l) => l.startsWith(`${tag} `))?.slice(tag.length + 1);

test('the wrapper passes the lint exit codes 0/1/2 through', { skip: !hasPython && 'python3 not on PATH' }, async () => {
  for (const code of [0, 1, 2]) {
    const dir = await stubRepo(code);
    const res = await runWrapper(dir);
    assert.equal(res.code, code, `exit ${code}: ${res.stderr}`);
    if (code !== 2) assert.match(res.stdout, /## Deterministic wiki lint/);
  }
});

test('the stub lint runs with no arguments, in REPO_ROOT, and never sees console secrets', { skip: !hasPython && 'python3 not on PATH' }, async () => {
  const dir = await stubRepo(0);
  const res = await runWrapper(dir, {
    FIREFLY_URL: 'http://127.0.0.1:8081',
    FIREFLY_TOKEN: 'synthetic-firefly-token',
    PROXY_HOSTNAME: 'console.example',
    PROXY_SECRET: 's'.repeat(40),
    SOME_OTHER_VAR: 'x',
  });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(line(res.stdout, 'STUB-ARGV')), []);
  assert.equal(await fs.realpath(line(res.stdout, 'STUB-CWD')), await fs.realpath(dir));
  const keys = JSON.parse(line(res.stdout, 'STUB-ENV'));
  for (const secret of ['FIREFLY_TOKEN', 'FIREFLY_URL', 'PROXY_SECRET', 'PROXY_HOSTNAME', 'REPO_ROOT', 'SOME_OTHER_VAR']) {
    assert.equal(keys.includes(secret), false, `${secret} leaked into the lint's environment`);
  }
  assert.ok(keys.includes('PYTHONDONTWRITEBYTECODE'));
  assert.equal(line(res.stdout, 'STUB-DONTWRITEBYTECODE'), 'True');
  assert.ok(!res.stdout.includes('synthetic-firefly-token'));
});

test('a missing lint script is a wrapper failure (exit 3), not the lint\'s 2', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aos-wiki-lint-empty-'));
  const res = await runWrapper(dir);
  assert.equal(res.code, WRAPPER_FAILURE_EXIT);
  assert.match(res.stderr, /is not a file/);
});

test('an interpreter that cannot be spawned is a wrapper failure (exit 3)', async () => {
  const dir = await stubRepo(0);
  // A .venv/bin/python that exists but is not executable → spawn fails.
  await fs.mkdir(path.join(dir, '.venv', 'bin'), { recursive: true });
  await fs.writeFile(path.join(dir, '.venv', 'bin', 'python'), 'not an interpreter', { mode: 0o644 });
  const res = await runWrapper(dir);
  assert.equal(res.code, WRAPPER_FAILURE_EXIT);
  assert.match(res.stderr, /could not run/);
});
