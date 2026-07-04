import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXECUTABLE_ALLOWLIST } from './operations.js';
import { appendAuditEntry } from './audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = path.resolve(__dirname, '../..');

/**
 * Phase 3 controlled execution (ADR-0001), async job model since Phase 4.2.
 * The safety model, in code:
 *
 * - The browser can never run arbitrary shell. The client-supplied `:id`
 *   only *selects a row* in a fixed command table derived from the permanent
 *   allowlist — it is never interpolated into a command, and spawn() runs
 *   with `shell: false`.
 * - Every run is dry-run first: dry-run issues a short-lived, single-use
 *   confirm token bound to the operation id; run requires `confirm: true`
 *   plus that token. No token, no execution.
 * - One run at a time (single-flight); concurrent run attempts get 409.
 * - run() starts a job and returns immediately (202 at the route); progress
 *   is observable via getRun(runId) snapshots and subscribe(runId) events —
 *   the streaming changes nothing about what may execute or when.
 * - Around every run: a `git status --porcelain` snapshot before/after, and
 *   a `git diff` when anything changed — the allowlisted checks are
 *   read-only, so a non-empty diff is itself a finding worth surfacing.
 * - Every run appends one JSON line (op, ts, status, files, output) to the
 *   audit log at completion, success or failure — same shape as the
 *   synchronous era.
 */

/** Fixed command table: every allowlisted id is exactly `npm run <id>`. */
function defaultCommands() {
  return Object.fromEntries(EXECUTABLE_ALLOWLIST.map((id) => [id, ['npm', 'run', id]]));
}

export const CONFIRM_TOKEN_TTL_MS = 10 * 60 * 1000;
export const RUN_TIMEOUT_MS = 10 * 60 * 1000;
export const JOB_HISTORY_LIMIT = 20;
const OUTPUT_CAP = 100_000; // per stream, snapshot payload (tail kept)
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
  const jobs = new Map(); // runId → job (insertion order = start order)
  let running = null; // runId of the in-flight job, or null

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

  /** Public job view: caps the streams, hides listeners. */
  function snapshot(job) {
    return {
      runId: job.runId,
      op: job.op,
      status: job.status,
      command: job.command,
      cwd: PLATFORM_DIR,
      ts: job.ts,
      startedAt: job.ts,
      finishedAt: job.finishedAt,
      exitCode: job.exitCode,
      durationMs: job.durationMs,
      stdout: tail(job.stdout, OUTPUT_CAP),
      stderr: tail(job.stderr, OUTPUT_CAP),
      gitAvailable: job.gitAvailable,
      changedFiles: job.changedFiles,
      gitDiff: job.gitDiff,
    };
  }

  function emit(job, event) {
    for (const listener of job.listeners) listener(event);
  }

  function pruneJobs() {
    const finished = [...jobs.values()].filter((j) => j.status !== 'running');
    for (let i = 0; i < finished.length - JOB_HISTORY_LIMIT; i++) {
      jobs.delete(finished[i].runId);
    }
  }

  /** The actual execution — runs detached from the HTTP request. */
  async function execute(job, argv) {
    try {
      const statusBefore = await gitCapture(config.REPO_ROOT, ['status', '--porcelain']);
      const t0 = Date.now();

      const result = await new Promise((resolve) => {
        const child = spawn(argv[0], argv.slice(1), {
          cwd: PLATFORM_DIR,
          shell: false,
          env: { ...process.env, REPO_ROOT: config.REPO_ROOT },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeoutMs);
        child.stdout.on('data', (d) => {
          job.stdout += d;
          emit(job, { type: 'output', stream: 'stdout', chunk: String(d) });
        });
        child.stderr.on('data', (d) => {
          job.stderr += d;
          emit(job, { type: 'output', stream: 'stderr', chunk: String(d) });
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          job.stderr += `\nspawn failed: ${err.message}`;
          resolve({ exitCode: null, timedOut });
        });
        child.on('exit', (exitCode) => {
          clearTimeout(timer);
          resolve({ exitCode, timedOut });
        });
      });

      const statusAfter = await gitCapture(config.REPO_ROOT, ['status', '--porcelain']);
      job.gitAvailable = statusBefore !== null && statusAfter !== null;
      if (job.gitAvailable) {
        const before = new Set(statusBefore.split('\n').filter(Boolean));
        job.changedFiles = statusAfter.split('\n').filter((line) => line && !before.has(line));
        if (job.changedFiles.length > 0) {
          job.gitDiff = tail((await gitCapture(config.REPO_ROOT, ['diff'])) ?? '', OUTPUT_CAP);
        }
      }

      job.exitCode = result.exitCode;
      job.durationMs = Date.now() - t0;
      job.status = result.timedOut ? 'timeout' : result.exitCode === 0 ? 'ok' : 'failed';
    } catch (err) {
      job.stderr += `\nexecutor error: ${err.message}`;
      job.status = 'failed';
      job.durationMs = job.durationMs ?? 0;
    } finally {
      job.finishedAt = new Date().toISOString();
      running = null;
      // Audit at completion — same line shape as the synchronous era.
      try {
        await appendAuditEntry(config, {
          ts: job.ts,
          op: job.op,
          status: job.status,
          exitCode: job.exitCode,
          durationMs: job.durationMs,
          command: job.command,
          files: job.changedFiles,
          output: {
            stdout: tail(job.stdout, AUDIT_OUTPUT_CAP),
            stderr: tail(job.stderr, AUDIT_OUTPUT_CAP),
          },
        });
      } catch (err) {
        job.stderr += `\naudit append failed: ${err.message}`;
      }
      emit(job, { type: 'done', snapshot: snapshot(job) });
      job.listeners.clear();
      pruneJobs();
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

    /**
     * POST /api/operations/:id/run — validate (allowlist, confirm, token,
     * single-flight), start the job, return its first snapshot immediately.
     * The route answers 202; progress via getRun()/subscribe().
     */
    run(id, body = {}) {
      const argv = requireExecutable(id);
      if (body.confirm !== true) {
        throw new ExecError(400, 'confirm-required', 'run requires an explicit {"confirm": true}');
      }
      consumeToken(id, body.confirmToken);
      if (running !== null) {
        throw new ExecError(409, 'run-in-flight', `another operation is already running (run ${running})`);
      }

      const job = {
        runId: crypto.randomUUID(),
        op: id,
        status: 'running',
        command: argv.join(' '),
        ts: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        durationMs: null,
        stdout: '',
        stderr: '',
        gitAvailable: null,
        changedFiles: null,
        gitDiff: null,
        listeners: new Set(),
      };
      running = job.runId;
      jobs.set(job.runId, job);
      void execute(job, argv); // detached — completion clears `running`
      return snapshot(job);
    },

    /** GET /api/operations/runs/:runId — job snapshot, or null if unknown. */
    getRun(runId) {
      const job = jobs.get(runId);
      return job ? snapshot(job) : null;
    },

    /**
     * Subscribe to a job's events ({type:'output'|'done'}); returns an
     * unsubscribe function. A finished job emits nothing further — callers
     * should read getRun() first (the SSE route sends that snapshot).
     */
    subscribe(runId, listener) {
      const job = jobs.get(runId);
      if (!job || job.status !== 'running') return () => {};
      job.listeners.add(listener);
      return () => job.listeners.delete(listener);
    },
  };
}
