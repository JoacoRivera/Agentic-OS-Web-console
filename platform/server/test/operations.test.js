import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';

const app = createApp(createConfig({ REPO_ROOT: '/tmp/fixture-root' }));

test('POST /api/operations/:id/run returns 501 in P1 (ADR-0001)', async () => {
  const res = await request(app)
    .post('/api/operations/check-paths/run')
    .set('Host', '127.0.0.1:3001');
  assert.equal(res.status, 501);
  assert.equal(res.body.error, 'not-implemented');
});

test('POST /api/operations/:id/dry-run returns 501 in P1 (ADR-0001)', async () => {
  const res = await request(app)
    .post('/api/operations/anything/dry-run')
    .set('Host', '127.0.0.1:3001');
  assert.equal(res.status, 501);
});
