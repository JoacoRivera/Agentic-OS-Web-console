import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXECUTABLE_ALLOWLIST } from './operations.js';
import { appendAuditEntry } from './audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = path.resolve(__dirname, '../..');

/**
 * Phase 3 controlled execution (ADR-0001). The safety model, in code:
 *
 * - The browser can never run arbitrary shell. The client-supplied `:id`
 *   only *selects a row* in a fixed command table derived from the permanent
 *   allowlist — it is never interpolated into a command, and spawn() runs
 *   with `shell: false`.
 * - Every run is dry-run first: dry-run issues a short-lived, single-use
 *   confirm token bound to the operation id; run requires `confirm: true`
 *   plus that token. No token, no execution.
 * - One run at a time (single-flight); concurrent run attempts get 409.
 * - Around every run: a `git status --porcelain` snapshot before/after, and
 *   a `git diff` when anything changed — the allowlisted checks are
 *   read-only, so a non-empty diff is itself a finding worth surfacing.
 * - Every run appends one JSON line (op, ts, status, files, output) to the
 *   audit log, success or failure.
 */

/** Fixed command table: every allowlisted id is exactly `npm run <id>`. */
function defaultCommands() {
  return Object.fromEntries(EXECUTABLE_ALLOWLIST.map((id) => [id, ['npm', 'run', id]]));
}

export const CONFIRM_TOKEN_TTL_MS = 10 * 60 * 1000;
export const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_CAP = 100_000; // per stream, response payload (tail kept)
const AUDIT_OUTPUT_CAP = 4_000; // per stream, audit line (tail kept)

class ExecError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ExecError';
    this.status = status;
    this.code = code;
  }
}

const tail = (text, cap) => (text.length > cap ? `…[truncated]…${text.slice(-cap)}` : text);

/** Run a git command in repoRoot; null when git/repo is unavailable. */
function gitCapture(repoRoot, args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd: repoRoot, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('exit', (code) => resolve(code === 0 ? out : null));
  });
}

/**
 * Build the executor. `commands` and `timeoutMs` are test seams — production
 * callers take the defaults, so the table always mirrors the allowlist.
 */
export function createExecutor(config, { commands = defaultCommands(), timeoutMs = RUN_TIMEOUT_MS } = {}) {
  const tokens = new Map(); // token → { id, expiresAt }
  let running = null; // id of the in-flight run, or null

  function requireExecutable(id) {
    if (!EXECUTABLE_ALLOWLIST.includes(id) || !commands[id]) {
      // Guided operations exist but are deliberately not runnable (ADR-0001);
      // distinguish "not executable" from "no such operation".
      throw new ExecError(
        405,
        'not-executable',
        `"${id}" is not in the executable allowlist — LLM Skills and guided operations are never console-executable (ADR-0001)`
      );
    }
    return commands[id];
  }

  function issueToken(id) {
    const token = crypto.randomUUID();
    tokens.set(token, { id, expiresAt: Date.now() + CONFIRM_TOKEN_TTL_MS });
    return token;
  }

  function consumeToken(id, token) {
    const entry = typeof token === 'string' ? tokens.get(token) : undefined;
    if (entry) tokens.delete(token); // single-use, even on mismatch/expiry
    if (!entry || entry.id !== id || entry.expiresAt < Date.now()) {
      throw new ExecError(
        400,
        'confirm-token-invalid',
        'run requires a fresh confirmToken from a dry-run of the same operation'
      );
    }
  }

  return {
    /** POST /api/operations/:id/dry-run — describe the run, issue the confirm token. */
    dryRun(id) {
      const argv = requireExecutable(id);
      return {
        id,
        mode: 'dry-run',
        command: argv.join(' '),
        cwd: PLATFORM_DIR,
        repoRoot: config.REPO_ROOT,
        timeoutMs,
        confirmToken: issueToken(id),
        confirmTokenTtlMs: CONFIRM_TOKEN_TTL_MS,
        note:
          'Nothing was executed. To run, POST /run with {"confirm": true, "confirmToken": ...} ' +
          'within the token TTL. The command is fixed by the allowlist — the id only selects it.',
      };
    },

    /** POST /api/operations/:id/run — execute after dry-run + explicit confirm. */
    async run(id, body = {}) {
      const argv = requireExecutable(id);
      if (body.confirm !== true) {
        throw new ExecError(400, 'confirm-required', 'run requires an explicit {"confirm": true}');
      }
      consumeToken(id, body.confirmToken);
      if (running !== null) {
        throw new ExecError(409, 'run-in-flight', `another operation (${running}) is already running`);
      }
      running = id;
      try {
        const statusBefore = await gitCapture(config.REPO_ROOT, ['status', '--porcelain']);
        const startedAt = new Date();
        const t0 = Date.now();

        const result = await new Promise((resolve) => {
          const child = spawn(argv[0], argv.slice(1), {
            cwd: PLATFORM_DIR,
            shell: false,
            env: { ...process.env, REPO_ROOT: config.REPO_ROOT },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs);
          child.stdout.on('data', (d) => (stdout += d));
          child.stderr.on('data', (d) => (stderr += d));
          child.on('error', (err) => {
            clearTimeout(timer);
            resolve({ exitCode: null, stdout, stderr: `${stderr}\nspawn failed: ${err.message}`, timedOut });
          });
          child.on('exit', (exitCode) => {
            clearTimeout(timer);
            resolve({ exitCode, stdout, stderr, timedOut });
          });
        });

        const statusAfter = await gitCapture(config.REPO_ROOT, ['status', '--porcelain']);
        const gitAvailable = statusBefore !== null && statusAfter !== null;
        let changedFiles = null;
        let gitDiff = null;
        if (gitAvailable) {
          const before = new Set(statusBefore.split('\n').filter(Boolean));
          changedFiles = statusAfter.split('\n').filter((line) => line && !before.has(line));
          if (changedFiles.length > 0) {
            gitDiff = tail((await gitCapture(config.REPO_ROOT, ['diff'])) ?? '', OUTPUT_CAP);
          }
        }

        const status = result.timedOut ? 'timeout' : result.exitCode === 0 ? 'ok' : 'failed';
        const entry = {
          ts: startedAt.toISOString(),
          op: id,
          status,
          exitCode: result.exitCode,
          durationMs: Date.now() - t0,
          command: argv.join(' '),
          files: changedFiles,
          output: {
            stdout: tail(result.stdout, AUDIT_OUTPUT_CAP),
            stderr: tail(result.stderr, AUDIT_OUTPUT_CAP),
          },
        };
        await appendAuditEntry(config, entry);

        return {
          ...entry,
          stdout: tail(result.stdout, OUTPUT_CAP),
          stderr: tail(result.stderr, OUTPUT_CAP),
          gitAvailable,
          changedFiles,
          gitDiff,
          output: undefined, // audit-line form; the response carries the fuller streams above
        };
      } finally {
        running = null;
      }
    },
  };
}
