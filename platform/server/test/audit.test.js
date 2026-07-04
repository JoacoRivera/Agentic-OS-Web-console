import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';

const get = (app) => request(app).get('/api/audit').set('Host', '127.0.0.1:3001');

test('GET /api/audit responds with an empty tail when no log exists (P1)', async () => {
  const app = createApp(
    createConfig({ REPO_ROOT: '/tmp/fixture-root', AUDIT_LOG_PATH: '/tmp/fixture-root/no-such.log' })
  );
  const res = await get(app);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.entries, []);
  assert.equal(res.body.total, 0);
});

test('GET /api/audit tails the operations log, parsing JSON lines and keeping raw ones', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aos-audit-'));
  const logPath = path.join(dir, 'operations.log');
  await fs.writeFile(
    logPath,
    JSON.stringify({ op: 'check:paths', ts: '2026-07-04T00:00:00Z', status: 'ok' }) +
      '\n' +
      'not-json line\n\n'
  );
  const app = createApp(createConfig({ REPO_ROOT: '/tmp/fixture-root', AUDIT_LOG_PATH: logPath }));
  const res = await get(app);
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 2);
  assert.deepEqual(res.body.entries[0], { op: 'check:paths', ts: '2026-07-04T00:00:00Z', status: 'ok' });
  assert.deepEqual(res.body.entries[1], { raw: 'not-json line' });
  await fs.rm(dir, { recursive: true, force: true });
});
