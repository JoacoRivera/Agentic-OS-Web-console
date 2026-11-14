// check:wiki-structure — the deterministic wiki lint, as a permanent allowlist
// entry (ADR-0001 amendment, 2026-11-14). Runs the memory repo's own
// `scripts/wiki-lint.py` in REPO_ROOT and passes its report and exit code
// through unchanged; the console never reimplements the lint.
//
// This is the only allowlisted check whose code lives in REPO_ROOT rather
// than in this repository, so the amendment's rules are enforced here:
// - fixed command: the script path and interpreter are fixed, and the lint
//   gets NO arguments (no --root, no --today) — nothing from a caller reaches
//   its argv;
// - minimal environment: the child sees only PATH/HOME/locale/TZ plus
//   PYTHONDONTWRITEBYTECODE=1 — no console secret (FIREFLY_TOKEN,
//   PROXY_SECRET, auth config) ever reaches code outside this repo;
// - read-only: the lint only reads, and bytecode writes are disabled, so a
//   run writes nothing into the memory repo (the executor's before/after
//   `git status` would surface it if it did).
//
// Exit codes: the lint's own 0 (no errors) / 1 (errors) / 2 (not a lintable
// root) pass through; 3 = this wrapper could not run it (script missing,
// interpreter not spawnable), so it is never confused with the lint's 2.
//
// Usage: REPO_ROOT=<memory repo> node scripts/check-wiki-structure.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WRAPPER_FAILURE_EXIT = 3;
export const LINT_SCRIPT = path.join('scripts', 'wiki-lint.py');
export const VENV_PYTHON = path.join('.venv', 'bin', 'python');

/** Environment keys copied from the parent when set — nothing else is. */
export const LINT_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'];

/** The child's whole environment: an allowlist of the parent's, plus no-bytecode. */
export function lintEnv(env) {
  const out = {};
  for (const key of LINT_ENV_KEYS) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  out.PYTHONDONTWRITEBYTECODE = '1';
  return out;
}

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * The fixed command for a repo root. The interpreter is the repo's own
 * `.venv/bin/python` when it exists (the memory repo's bootstrap creates it
 * exactly when the system interpreter lacks the deps), else `python3`.
 * `exists` is a test seam.
 */
export function resolveLintCommand(repoRoot, { exists = isFile } = {}) {
  const script = path.join(repoRoot, LINT_SCRIPT);
  const venvPython = path.join(repoRoot, VENV_PYTHON);
  return {
    python: exists(venvPython) ? venvPython : 'python3',
    argv: [script],
    cwd: repoRoot,
    script,
  };
}

/** Run the lint; resolves to the exit code this wrapper should exit with. */
export async function runWikiLint(repoRoot, env = process.env) {
  const cmd = resolveLintCommand(repoRoot);
  if (!isFile(cmd.script)) {
    console.error(`check:wiki-structure: ${cmd.script} is not a file — is REPO_ROOT the memory repo?`);
    return WRAPPER_FAILURE_EXIT;
  }
  return new Promise((resolve) => {
    const child = spawn(cmd.python, cmd.argv, {
      cwd: cmd.cwd,
      shell: false,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: lintEnv(env),
    });
    child.on('error', (err) => {
      console.error(`check:wiki-structure: could not run ${cmd.python}: ${err.message}`);
      resolve(WRAPPER_FAILURE_EXIT);
    });
    child.on('exit', (code, signal) => {
      if (code === null) {
        console.error(`check:wiki-structure: the lint was killed by ${signal}`);
        resolve(WRAPPER_FAILURE_EXIT);
      } else {
        resolve(code);
      }
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const { createConfig } = await import('../server/src/config.js');
  let repoRoot;
  try {
    repoRoot = createConfig(process.env).REPO_ROOT;
  } catch (err) {
    console.error(`check:wiki-structure: ${err.message}`);
    process.exit(WRAPPER_FAILURE_EXIT);
  }
  process.exitCode = await runWikiLint(repoRoot);
}
