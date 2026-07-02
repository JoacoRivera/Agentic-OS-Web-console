import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig, assertStartable, isLoopbackHostname } from '../src/config.js';

test('defaults: loopback host, port 3001, raw content hidden', () => {
  const config = createConfig({});
  assert.equal(config.HOST, '127.0.0.1');
  assert.equal(config.PORT, 3001);
  assert.equal(config.EXPOSE_RAW_CONTENT, false);
  assert.equal(config.AUTH_CONFIGURED, false);
});

test('EXPOSE_RAW_CONTENT only enables on the exact string "true"', () => {
  assert.equal(createConfig({ EXPOSE_RAW_CONTENT: 'true' }).EXPOSE_RAW_CONTENT, true);
  for (const v of ['1', 'yes', 'TRUE', '']) {
    assert.equal(createConfig({ EXPOSE_RAW_CONTENT: v }).EXPOSE_RAW_CONTENT, false, v);
  }
});

test('REPO_ROOT env override is resolved to an absolute path', () => {
  assert.ok(createConfig({ REPO_ROOT: '/x/y' }).REPO_ROOT.startsWith('/x'));
});

test('loopback hostname classification', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', 'LOCALHOST']) {
    assert.equal(isLoopbackHostname(h), true, h);
  }
  for (const h of ['0.0.0.0', '192.168.1.10', 'example.com', '', null, '127.0.0.1.evil.example']) {
    assert.equal(isLoopbackHostname(h), false, String(h));
  }
});

test('assertStartable passes on loopback hosts', () => {
  for (const HOST of ['127.0.0.1', 'localhost', '::1']) {
    assert.doesNotThrow(() => assertStartable(createConfig({ HOST })));
  }
});

test('assertStartable throws on a non-loopback HOST without auth (ADR-0005)', () => {
  for (const HOST of ['0.0.0.0', '192.168.1.10', 'myhost.local']) {
    assert.throws(() => assertStartable(createConfig({ HOST })), /ADR-0005/, HOST);
  }
});
