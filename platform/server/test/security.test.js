import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';

const app = createApp(createConfig({ REPO_ROOT: '/tmp/fixture-root' }));
const appWithAlias = createApp(
  createConfig({
    REPO_ROOT: '/tmp/fixture-root',
    LOCAL_HOSTNAME: 'agentic-os-console.localhost',
  })
);

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

test('the explicit local hostname is accepted for Host and same-origin requests', async () => {
  const get = await request(appWithAlias)
    .get('/api/status')
    .set('Host', 'agentic-os-console.localhost');
  assert.equal(get.status, 200);
  assert.equal(get.body.localHostname, 'agentic-os-console.localhost');

  const post = await request(appWithAlias)
    .post('/api/operations/nope/dry-run')
    .set('Host', 'agentic-os-console.localhost')
    .set('Origin', 'http://agentic-os-console.localhost');
  assert.equal(post.status, 405);
});

test('an unconfigured local-looking alias is rejected', async () => {
  const res = await request(app)
    .get('/api/status')
    .set('Host', 'agentic-os-console.localhost');
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden-host');
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

const PROXY_SECRET = 's'.repeat(40);
const appWithProxy = createApp(
  createConfig({
    REPO_ROOT: '/tmp/fixture-root',
    PROXY_HOSTNAME: 'aos-console.home.arpa',
    PROXY_SECRET,
  })
);

test('the proxy hostname is accepted only with the proxy secret header', async () => {
  const missing = await request(appWithProxy).get('/api/status').set('Host', 'aos-console.home.arpa');
  assert.equal(missing.status, 403);
  assert.equal(missing.body.error, 'forbidden-proxy');

  const wrong = await request(appWithProxy)
    .get('/api/status')
    .set('Host', 'aos-console.home.arpa')
    .set('X-AOS-Proxy-Auth', 'x'.repeat(40));
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error, 'forbidden-proxy');

  const ok = await request(appWithProxy)
    .get('/api/status')
    .set('Host', 'aos-console.home.arpa')
    .set('X-AOS-Proxy-Auth', PROXY_SECRET);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.proxyHostname, 'aos-console.home.arpa');
});

test('proxied requests accept only the proxy origin', async () => {
  const same = await request(appWithProxy)
    .post('/api/operations/nope/dry-run')
    .set('Host', 'aos-console.home.arpa')
    .set('X-AOS-Proxy-Auth', PROXY_SECRET)
    .set('Origin', 'http://aos-console.home.arpa');
  assert.equal(same.status, 405);

  for (const origin of ['http://localhost:5173', 'https://evil.example', 'null']) {
    const res = await request(appWithProxy)
      .get('/api/status')
      .set('Host', 'aos-console.home.arpa')
      .set('X-AOS-Proxy-Auth', PROXY_SECRET)
      .set('Origin', origin);
    assert.equal(res.status, 403, `Origin: ${origin}`);
    assert.equal(res.body.error, 'forbidden-origin');
  }
});

test('the proxy origin is not trusted on loopback-Host requests', async () => {
  const res = await request(appWithProxy)
    .get('/api/status')
    .set('Host', '127.0.0.1:3001')
    .set('Origin', 'http://aos-console.home.arpa');
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden-origin');
});

test('without proxy config, the proxy hostname is an ordinary forbidden host', async () => {
  const res = await request(app)
    .get('/api/status')
    .set('Host', 'aos-console.home.arpa')
    .set('X-AOS-Proxy-Auth', PROXY_SECRET);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'forbidden-host');
});
