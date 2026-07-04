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
 * Full dry-run → confirm → run flow, with the executor's command-table test
 * seam: real allowlist ids mapped to fast node one-liners instead of the
 * real npm scripts. The safety semantics under test are identical.
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

const dryRun = async (app, id) => {
  const res = await post(app, `/api/operations/${encodeURIComponent(id)}/dry-run`);
  assert.equal(res.status, 200);
  return res.body;
};

test('dry-run → confirm → run executes, reports streams, and appends an audit line', async () => {
  const { app, config } = await makeApp({
    'check:paths': [node, '-e', 'console.log("stdout-ok"); console.error("stderr-note")'],
  });

  const dry = await dryRun(app, 'check:paths');
  const run = await post(app, '/api/operations/check%3Apaths/run', {
    confirm: true,
    confirmToken: dry.confirmToken,
  });
  assert.equal(run.status, 200);
  assert.equal(run.body.status, 'ok');
  assert.equal(run.body.exitCode, 0);
  assert.equal(run.body.op, 'check:paths');
  assert.ok(run.body.stdout.includes('stdout-ok'));
  assert.ok(run.body.stderr.includes('stderr-note'));
  // The tmp REPO_ROOT is not a git repo — surfaced honestly, not faked.
  assert.equal(run.body.gitAvailable, false);
  assert.equal(run.body.changedFiles, null);

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
  const run = await post(app, '/api/operations/check%3Adocs/run', {
    confirm: true,
    confirmToken: dry.confirmToken,
  });
  assert.equal(run.status, 200); // the run happened; failure is a result, not an HTTP error
  assert.equal(run.body.status, 'failed');
  assert.equal(run.body.exitCode, 2);
  const entry = JSON.parse((await fs.readFile(config.AUDIT_LOG_PATH, 'utf8')).trim());
  assert.equal(entry.status, 'failed');
});

test('a hung command is killed at the timeout and audited as timeout', async () => {
  const { app, config } = await makeApp(
    { 'check:skills': [node, '-e', 'setTimeout(() => {}, 60000)'] },
    { timeoutMs: 300 }
  );
  const dry = await dryRun(app, 'check:skills');
  const run = await post(app, '/api/operations/check%3Askills/run', {
    confirm: true,
    confirmToken: dry.confirmToken,
  });
  assert.equal(run.status, 200);
  assert.equal(run.body.status, 'timeout');
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

  // Single-use: the same token cannot run twice.
  const dry = await dryRun(app, 'check:paths');
  const first = await post(app, '/api/operations/check%3Apaths/run', {
    confirm: true,
    confirmToken: dry.confirmToken,
  });
  assert.equal(first.status, 200);
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
  // .then() kicks off the supertest request without awaiting completion.
  const inFlight = post(app, '/api/operations/check%3Apaths/run', {
    confirm: true,
    confirmToken: dryA.confirmToken,
  }).then((res) => res);
  await new Promise((r) => setTimeout(r, 100)); // let the first run start
  const second = await post(app, '/api/operations/check%3Adocs/run', {
    confirm: true,
    confirmToken: dryB.confirmToken,
  });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'run-in-flight');
  const first = await inFlight;
  assert.equal(first.status, 200);
});

test('the default command table is exactly `npm run <id>` for the allowlist', async () => {
  const config = createConfig({ REPO_ROOT: '/tmp/fixture-root' });
  const executor = createExecutor(config);
  for (const id of EXECUTABLE_ALLOWLIST) {
    const dry = executor.dryRun(id);
    assert.equal(dry.command, `npm run ${id}`);
  }
  // ...and nothing else is executable, even with a confirm payload.
  await assert.rejects(
    executor.run('wiki-lint', { confirm: true, confirmToken: 'x' }),
    (err) => err.status === 405
  );
});
