import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { createExecutor } from '../src/executor.js';
import { appendAuditEntry } from '../src/audit.js';
import { EXECUTABLE_ALLOWLIST } from '../src/operations.js';

/**
 * Full dry-run → confirm → run flow over the async job model (roadmap §4.2),
 * using the executor's command-table test seam: real allowlist ids mapped to
 * fast node one-liners instead of the real npm scripts. The safety semantics
 * under test are identical to production.
 */

const node = process.execPath;

async function makeApp(commands, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aos-exec-'));
  const config = createConfig({
    REPO_ROOT: dir,
    AUDIT_LOG_PATH: path.join(dir, 'logs', 'operations.log'),
  });
  const executor = createExecutor(config, { commands, timeoutMs: 5000, ...extra });
  return { app: createApp(config, { executor }), config, dir };
}

const post = (app, urlPath, body) =>
  request(app).post(urlPath).set('Host', '127.0.0.1:3001').send(body);
const get = (app, urlPath) => request(app).get(urlPath).set('Host', '127.0.0.1:3001');

const dryRun = async (app, id) => {
  const res = await post(app, `/api/operations/${encodeURIComponent(id)}/dry-run`);
  assert.equal(res.status, 200);
  return res.body;
};

/** POST run (expects 202) then poll the snapshot route until it finishes. */
async function runAndWait(app, id, token) {
  const started = await post(app, `/api/operations/${encodeURIComponent(id)}/run`, {
    confirm: true,
    confirmToken: token,
  });
  assert.equal(started.status, 202);
  assert.equal(started.body.status, 'running');
  assert.ok(started.body.runId);
  const deadline = Date.now() + 8000;
  for (;;) {
    const snap = await get(app, `/api/operations/runs/${started.body.runId}`);
    assert.equal(snap.status, 200);
    if (snap.body.status !== 'running') return snap.body;
    assert.ok(Date.now() < deadline, 'run did not finish in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('dry-run → confirm → run executes async, reports streams, and appends an audit line', async () => {
  const { app, config } = await makeApp({
    'check:paths': [node, '-e', 'console.log("stdout-ok"); console.error("stderr-note")'],
  });

  const dry = await dryRun(app, 'check:paths');
  const run = await runAndWait(app, 'check:paths', dry.confirmToken);
  assert.equal(run.status, 'ok');
  assert.equal(run.exitCode, 0);
  assert.equal(run.op, 'check:paths');
  assert.ok(run.stdout.includes('stdout-ok'));
  assert.ok(run.stderr.includes('stderr-note'));
  assert.ok(run.finishedAt);
  // The tmp REPO_ROOT is not a git repo — surfaced honestly, not faked.
  assert.equal(run.gitAvailable, false);
  assert.equal(run.changedFiles, null);

  const auditText = await fs.readFile(config.AUDIT_LOG_PATH, 'utf8');
  const entry = JSON.parse(auditText.trim());
  assert.equal(entry.op, 'check:paths');
  assert.equal(entry.status, 'ok');
  assert.ok(entry.output.stdout.includes('stdout-ok'));
});

test('a failing command is audited as failed with its exit code', async () => {
  const { app, config } = await makeApp({
    'check:docs': [node, '-e', 'console.error("boom"); process.exit(2)'],
  });
  const dry = await dryRun(app, 'check:docs');
  const run = await runAndWait(app, 'check:docs', dry.confirmToken);
  assert.equal(run.status, 'failed');
  assert.equal(run.exitCode, 2);
  const entry = JSON.parse((await fs.readFile(config.AUDIT_LOG_PATH, 'utf8')).trim());
  assert.equal(entry.status, 'failed');
});

test('a hung command is killed at the timeout and audited as timeout', async () => {
  const { app, config } = await makeApp(
    { 'check:skills': [node, '-e', 'setTimeout(() => {}, 60000)'] },
    { timeoutMs: 300 }
  );
  const dry = await dryRun(app, 'check:skills');
  const run = await runAndWait(app, 'check:skills', dry.confirmToken);
  assert.equal(run.status, 'timeout');
  const entry = JSON.parse((await fs.readFile(config.AUDIT_LOG_PATH, 'utf8')).trim());
  assert.equal(entry.status, 'timeout');
});

test('confirm tokens are single-use and bound to the operation id', async () => {
  const { app } = await makeApp({
    'check:paths': [node, '-e', ''],
    'check:docs': [node, '-e', ''],
  });

  // Bound to the id: a check:docs token does not confirm check:paths.
  const cross = await dryRun(app, 'check:docs');
  const crossRun = await post(app, '/api/operations/check%3Apaths/run', {
    confirm: true,
    confirmToken: cross.confirmToken,
  });
  assert.equal(crossRun.status, 400);
  assert.equal(crossRun.body.error, 'confirm-token-invalid');

  // Single-use: the same token cannot start a second run.
  const dry = await dryRun(app, 'check:paths');
  await runAndWait(app, 'check:paths', dry.confirmToken);
  const replay = await post(app, '/api/operations/check%3Apaths/run', {
    confirm: true,
    confirmToken: dry.confirmToken,
  });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error, 'confirm-token-invalid');
});

test('runs are single-flight: a concurrent run gets 409', async () => {
  const { app } = await makeApp({
    'check:paths': [node, '-e', 'setTimeout(() => {}, 500)'],
    'check:docs': [node, '-e', ''],
  });
  const dryA = await dryRun(app, 'check:paths');
  const dryB = await dryRun(app, 'check:docs');
  const started = await post(app, '/api/operations/check%3Apaths/run', {
    confirm: true,
    confirmToken: dryA.confirmToken,
  });
  assert.equal(started.status, 202);
  const second = await post(app, '/api/operations/check%3Adocs/run', {
    confirm: true,
    confirmToken: dryB.confirmToken,
  });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'run-in-flight');
  // Drain: wait for the first to finish so nothing leaks across tests.
  const deadline = Date.now() + 5000;
  for (;;) {
    const snap = await get(app, `/api/operations/runs/${started.body.runId}`);
    if (snap.body.status !== 'running') break;
    assert.ok(Date.now() < deadline);
    await new Promise((r) => setTimeout(r, 25));
  }
});

test('unknown runId is 404 on both the snapshot and SSE routes', async () => {
  const { app } = await makeApp({ 'check:paths': [node, '-e', ''] });
  assert.equal((await get(app, '/api/operations/runs/nope')).status, 404);
  assert.equal((await get(app, '/api/operations/runs/nope/events')).status, 404);
});

test('the SSE route replays a finished run: snapshot then done, then closes', async () => {
  const { app } = await makeApp({
    'check:paths': [node, '-e', 'console.log("streamed-line")'],
  });
  const dry = await dryRun(app, 'check:paths');
  const run = await runAndWait(app, 'check:paths', dry.confirmToken);

  const res = await get(app, `/api/operations/runs/${run.runId}/events`);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.ok(res.text.includes('event: snapshot'));
  assert.ok(res.text.includes('event: done'));
  assert.ok(res.text.includes('streamed-line'));
});

test('the default command table is exactly `npm run <id>` for the allowlist', async () => {
  const config = createConfig({ REPO_ROOT: '/tmp/fixture-root' });
  const executor = createExecutor(config);
  for (const id of EXECUTABLE_ALLOWLIST) {
    const dry = executor.dryRun(id);
    assert.equal(dry.command, `npm run ${id}`);
  }
  // ...and nothing else is executable, even with a confirm payload.
  assert.throws(
    () => executor.run('wiki-lint', { confirm: true, confirmToken: 'x' }),
    (err) => err.status === 405
  );
});

/** Read the audit lines (bounded wait; since i01 the line is written before `done`). */
async function readAudit(config, minLines = 1) {
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      const lines = (await fs.readFile(config.AUDIT_LOG_PATH, 'utf8')).split('\n').filter(Boolean);
      if (lines.length >= minLines) return lines.map((l) => JSON.parse(l));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    assert.ok(Date.now() < deadline, 'audit line did not appear');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A node one-liner printing a canned lint report (synthetic messages). */
const lintReport = (errors, warnings, exitCode) => {
  const lines = [
    '> npm preamble',
    '## Deterministic wiki lint',
    `- errors: ${errors.length}`,
    `- warnings: ${warnings.length}`,
    ...errors.map((m) => `ERROR   ${m}`),
    ...warnings.map((m) => `WARNING ${m}`),
  ];
  return [node, '-e', `process.stdout.write(${JSON.stringify(lines.join('\n') + '\n')}); process.exit(${exitCode})`];
};

test('a check:wiki-structure run carries the parsed lint result on the snapshot and the audit line', async () => {
  const { app, config } = await makeApp({
    'check:wiki-structure': lintReport(['wiki/example/page.md: broken link'], ['wiki/example/other.md: orphan'], 1),
  });
  const dry = await dryRun(app, 'check:wiki-structure');
  const run = await runAndWait(app, 'check:wiki-structure', dry.confirmToken);
  assert.equal(run.status, 'failed');
  assert.equal(run.exitCode, 1);
  assert.equal(run.result.parsed, true);
  assert.equal(run.result.errors, 1);
  assert.equal(run.result.warnings, 1);
  assert.deepEqual(run.result.findings, [
    { level: 'error', message: 'wiki/example/page.md: broken link' },
    { level: 'warning', message: 'wiki/example/other.md: orphan' },
  ]);
  const [entry] = await readAudit(config);
  assert.deepEqual(entry.result, run.result);
});

test('the lint result is parsed from the full stdout, not the 4,000-char audit tail', async () => {
  // 120 errors × ~60 chars ≫ the audit tail cap: the header counts would be
  // cut from the audit line's output, but the stored result keeps them.
  const errors = Array.from({ length: 120 }, (_, i) => `wiki/example/page-${String(i).padStart(3, '0')}.md: broken link to missing.md`);
  const { app, config } = await makeApp({ 'check:wiki-structure': lintReport(errors, [], 1) });
  const dry = await dryRun(app, 'check:wiki-structure');
  await runAndWait(app, 'check:wiki-structure', dry.confirmToken);
  const [entry] = await readAudit(config);
  assert.ok(!entry.output.stdout.includes('## Deterministic wiki lint'), 'the audit tail lost the header');
  assert.equal(entry.result.parsed, true);
  assert.equal(entry.result.errors, 120);
  assert.equal(entry.result.findingsTotal, 120);
  assert.equal(entry.result.truncated, true);
});

test('ids without a result parser get result: null', async () => {
  const { app, config } = await makeApp({ 'check:paths': [node, '-e', 'console.log("## Deterministic wiki lint")'] });
  const dry = await dryRun(app, 'check:paths');
  const run = await runAndWait(app, 'check:paths', dry.confirmToken);
  assert.equal(run.result, null);
  const [entry] = await readAudit(config);
  assert.equal(entry.result, null);
});

test('a throwing result parser never fails the run or the audit append', async () => {
  const { app, config } = await makeApp(
    { 'check:wiki-structure': [node, '-e', 'console.log("ok")'] },
    {
      resultParsers: {
        'check:wiki-structure': () => {
          throw new Error('synthetic parser bug');
        },
      },
    }
  );
  const dry = await dryRun(app, 'check:wiki-structure');
  const run = await runAndWait(app, 'check:wiki-structure', dry.confirmToken);
  assert.equal(run.status, 'ok');
  assert.equal(run.result.parsed, false);
  assert.match(run.result.reason, /synthetic parser bug/);
  const [entry] = await readAudit(config);
  assert.equal(entry.status, 'ok');
  assert.equal(entry.result.parsed, false);
});

test('GET /api/maintenance/wiki-structure: no run on record, then the last run projected', async () => {
  const { app, config } = await makeApp({ 'check:wiki-structure': lintReport([], [], 0) });
  const before = await get(app, '/api/maintenance/wiki-structure');
  assert.equal(before.status, 200);
  assert.equal(before.body.operation.id, 'check:wiki-structure');
  assert.equal(before.body.operation.type, 'executable');
  assert.equal(before.body.lastRun, null);

  const dry = await dryRun(app, 'check:wiki-structure');
  const run = await runAndWait(app, 'check:wiki-structure', dry.confirmToken);
  await readAudit(config);
  const after = await get(app, '/api/maintenance/wiki-structure');
  assert.equal(after.status, 200);
  assert.deepEqual(Object.keys(after.body.lastRun).sort(), ['durationMs', 'exitCode', 'result', 'status', 'ts']);
  assert.equal(after.body.lastRun.ts, run.ts);
  assert.equal(after.body.lastRun.status, 'ok');
  assert.equal(after.body.lastRun.exitCode, 0);
  assert.equal(after.body.lastRun.result.parsed, true);
  assert.equal(after.body.lastRun.result.errors, 0);
  // Only the projection: no raw stdout/stderr through this endpoint.
  assert.equal('output' in after.body.lastRun, false);
});

test('GET /api/maintenance/wiki-structure sits behind the Host/Origin guard', async () => {
  const { app } = await makeApp({});
  const badHost = await request(app).get('/api/maintenance/wiki-structure').set('Host', 'evil.example');
  assert.equal(badHost.status, 403);
  const badOrigin = await get(app, '/api/maintenance/wiki-structure').set('Origin', 'http://evil.example');
  assert.equal(badOrigin.status, 403);
});

/*
 * Ordering: a run is reported finished (status, finishedAt, released
 * single-flight, `done`) only after its audit append has settled. These drive
 * the executor directly with a gated `appendAudit` seam — no timing involved.
 */

async function makeExecutor(commands, appendAudit) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aos-exec-'));
  const config = createConfig({
    REPO_ROOT: dir,
    AUDIT_LOG_PATH: path.join(dir, 'logs', 'operations.log'),
  });
  return { executor: createExecutor(config, { commands, timeoutMs: 5000, appendAudit }), config };
}

/** An appendAudit seam that holds every append until release() is called. */
function gatedAudit() {
  let enter;
  let release;
  const entered = new Promise((r) => (enter = r));
  const gate = new Promise((r) => (release = r));
  const appendAudit = async (config, entry) => {
    enter(entry);
    await gate;
    return appendAuditEntry(config, entry);
  };
  return { appendAudit, entered, release };
}

/** Start a run and collect its events; `done` resolves with the done event. */
function startRun(executor, id) {
  const { confirmToken } = executor.dryRun(id);
  const first = executor.run(id, { confirm: true, confirmToken });
  const events = [];
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  executor.subscribe(first.runId, (event) => {
    events.push(event);
    if (event.type === 'done') resolveDone(event);
  });
  return { runId: first.runId, events, done };
}

const exists = (p) =>
  fs.access(p).then(
    () => true,
    () => false
  );

test('a run is not reported finished until its audit line is written', async () => {
  const gated = gatedAudit();
  const { executor, config } = await makeExecutor(
    { 'check:paths': [node, '-e', 'console.log("ok")'] },
    gated.appendAudit
  );

  const run = startRun(executor, 'check:paths');
  const entry = await gated.entered;
  assert.equal(entry.status, 'ok');

  // The append is held: nothing may look finished yet.
  const held = executor.getRun(run.runId);
  assert.equal(held.status, 'running');
  assert.equal(held.finishedAt, null);
  assert.ok(!run.events.some((e) => e.type === 'done'));
  assert.equal(await exists(config.AUDIT_LOG_PATH), false);
  const { confirmToken } = executor.dryRun('check:paths');
  assert.throws(
    () => executor.run('check:paths', { confirm: true, confirmToken }),
    (err) => err.status === 409 && err.code === 'run-in-flight'
  );

  gated.release();
  const done = await run.done;
  assert.equal(done.snapshot.status, 'ok');
  const finished = executor.getRun(run.runId);
  assert.equal(finished.status, 'ok');
  assert.ok(finished.finishedAt);
  const lines = (await fs.readFile(config.AUDIT_LOG_PATH, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).status, done.snapshot.status);

  // Single-flight is released: a new run is accepted (and drained).
  const next = startRun(executor, 'check:paths');
  assert.equal((await next.done).snapshot.status, 'ok');
});

test('a failing run stays running until its failed audit line is written', async () => {
  const gated = gatedAudit();
  const { executor } = await makeExecutor(
    { 'check:docs': [node, '-e', 'process.exit(2)'] },
    gated.appendAudit
  );

  const run = startRun(executor, 'check:docs');
  const entry = await gated.entered;
  assert.equal(entry.status, 'failed');
  assert.equal(entry.exitCode, 2);
  assert.equal(executor.getRun(run.runId).status, 'running');

  gated.release();
  assert.equal((await run.done).snapshot.status, 'failed');
  assert.equal(executor.getRun(run.runId).status, 'failed');
});

test('a failed audit append still finishes the run and says so', async () => {
  const { executor } = await makeExecutor({ 'check:paths': [node, '-e', ''] }, async () => {
    throw new Error('disk full');
  });

  const run = startRun(executor, 'check:paths');
  await run.done;
  const finished = executor.getRun(run.runId);
  assert.equal(finished.status, 'ok');
  assert.ok(finished.finishedAt);
  assert.ok(finished.stderr.includes('audit append failed: disk full'));

  const next = startRun(executor, 'check:paths');
  assert.equal((await next.done).snapshot.status, 'ok');
});

test('a gated audit append holds a wiki-structure run running; the result lands on the audit line and the terminal snapshot together', async () => {
  const gated = gatedAudit();
  const report = '## Deterministic wiki lint\n- errors: 1\n- warnings: 0\nERROR   wiki/example/page.md: broken link\n';
  const { executor, config } = await makeExecutor(
    { 'check:wiki-structure': [node, '-e', `process.stdout.write(${JSON.stringify(report)}); process.exit(1)`] },
    gated.appendAudit
  );
  const run = startRun(executor, 'check:wiki-structure');

  // The command has exited and the append is waiting at the gate.
  const entry = await gated.entered;
  assert.equal(entry.result.parsed, true);
  assert.equal(entry.result.errors, 1);
  const held = executor.getRun(run.runId);
  assert.equal(held.status, 'running', 'still running while the audit append is gated');
  assert.equal(held.finishedAt, null);
  assert.equal(await exists(config.AUDIT_LOG_PATH), false);

  gated.release();
  const done = await run.done;
  assert.equal(done.snapshot.status, 'failed');
  assert.equal(done.snapshot.exitCode, 1);
  assert.deepEqual(done.snapshot.result, entry.result);
  const [line] = (await fs.readFile(config.AUDIT_LOG_PATH, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(line.status, 'failed');
  assert.deepEqual(line.result, done.snapshot.result);
  assert.deepEqual(executor.getRun(run.runId).result, line.result);
});
