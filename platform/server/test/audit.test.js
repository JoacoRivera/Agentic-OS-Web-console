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

test('rotation at the size threshold loses no lines across the boundary', async () => {
  const { appendAuditEntry, readAuditTail } = await import('../src/audit.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aos-audit-rot-'));
  const config = createConfig({
    REPO_ROOT: '/tmp/fixture-root',
    AUDIT_LOG_PATH: path.join(dir, 'operations.log'),
    AUDIT_ROTATE_BYTES: '120', // tiny threshold → rotate every couple of entries
    AUDIT_ROTATE_KEEP: '5',
  });

  const N = 12;
  for (let i = 0; i < N; i++) {
    await appendAuditEntry(config, { op: 'check:paths', seq: i, status: 'ok' });
  }

  const rotated = (await fs.readdir(dir)).filter((f) => f.startsWith('operations.log.'));
  assert.ok(rotated.length > 0, 'rotation actually happened at the tiny threshold');

  const tail = await readAuditTail(config);
  assert.equal(tail.total, N, 'no line lost across rotation boundaries');
  assert.deepEqual(
    tail.entries.map((e) => e.seq),
    Array.from({ length: N }, (_, i) => i),
    'entries stay in append order, oldest rotated file first'
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('the oldest rotation beyond AUDIT_ROTATE_KEEP is dropped, newest are kept', async () => {
  const { appendAuditEntry, readAuditTail } = await import('../src/audit.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aos-audit-keep-'));
  const config = createConfig({
    REPO_ROOT: '/tmp/fixture-root',
    AUDIT_LOG_PATH: path.join(dir, 'operations.log'),
    AUDIT_ROTATE_BYTES: '1', // rotate on every append after the first
    AUDIT_ROTATE_KEEP: '2',
  });
  for (let i = 0; i < 8; i++) {
    await appendAuditEntry(config, { op: 'check:paths', seq: i, status: 'ok' });
  }
  const rotated = (await fs.readdir(dir)).filter((f) => f.startsWith('operations.log.')).sort();
  assert.deepEqual(rotated, ['operations.log.1', 'operations.log.2'], 'exactly KEEP rotations remain');
  const tail = await readAuditTail(config);
  // live + .1 + .2 with one entry each — older ones were dropped by design.
  assert.deepEqual(tail.entries.map((e) => e.seq), [5, 6, 7]);
  await fs.rm(dir, { recursive: true, force: true });
});
