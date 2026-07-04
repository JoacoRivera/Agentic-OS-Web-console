import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { createExecutor } from '../src/executor.js';
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
