import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';

const app = createApp(createConfig({ REPO_ROOT: '/tmp/fixture-root' }));

test('loopback Host header is accepted', async () => {
  const res = await request(app).get('/api/status').set('Host', '127.0.0.1:3001');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ready');
});

test('localhost and [::1] Host headers are accepted', async () => {
  for (const host of ['localhost:3001', '[::1]:3001', 'localhost']) {
    const res = await request(app).get('/api/status').set('Host', host);
    assert.equal(res.status, 200, `Host: ${host}`);
  }
});

test('a non-loopback Host header is rejected (DNS-rebinding defense)', async () => {
  for (const host of ['evil.example', 'evil.example:3001', '192.168.1.10:3001', '127.0.0.1.evil.example']) {
    const res = await request(app).get('/api/status').set('Host', host);
    assert.equal(res.status, 403, `Host: ${host}`);
    assert.equal(res.body.error, 'forbidden-host');
  }
});

test('a missing/garbage Host header is rejected', async () => {
  const res = await request(app).get('/api/status').set('Host', '');
  assert.equal(res.status, 403);
});

test('a cross-origin Origin is rejected', async () => {
  for (const origin of ['https://evil.example', 'http://192.168.1.10:5173', 'null']) {
    const res = await request(app)
      .get('/api/status')
      .set('Host', '127.0.0.1:3001')
      .set('Origin', origin);
    assert.equal(res.status, 403, `Origin: ${origin}`);
    assert.equal(res.body.error, 'forbidden-origin');
  }
});

test('a loopback Origin is accepted', async () => {
  for (const origin of ['http://127.0.0.1:3001', 'http://localhost:5173']) {
    const res = await request(app)
      .get('/api/status')
      .set('Host', '127.0.0.1:3001')
      .set('Origin', origin);
    assert.equal(res.status, 200, `Origin: ${origin}`);
  }
});

test('no permissive CORS: responses carry no Access-Control-Allow-Origin', async () => {
  const res = await request(app)
    .get('/api/status')
    .set('Host', '127.0.0.1:3001')
    .set('Origin', 'http://localhost:5173');
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('unknown /api routes return JSON 404 behind the guard', async () => {
  const ok = await request(app).get('/api/nope').set('Host', '127.0.0.1:3001');
  assert.equal(ok.status, 404);
  const blocked = await request(app).get('/api/nope').set('Host', 'evil.example');
  assert.equal(blocked.status, 403);
});
