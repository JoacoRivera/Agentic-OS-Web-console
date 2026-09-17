import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createConfig,
  assertStartable,
  isAllowedLocalHostname,
  isLoopbackHostname,
} from '../src/config.js';

test('defaults: loopback host, port 3001, raw content hidden', () => {
  const config = createConfig({});
  assert.equal(config.HOST, '127.0.0.1');
  assert.equal(config.PORT, 3001);
  assert.equal(config.LOCAL_HOSTNAME, null);
  assert.equal(config.EXPOSE_RAW_CONTENT, false);
  assert.equal(config.AUTH_CONFIGURED, false);
});

test('LOCAL_HOSTNAME accepts and normalizes one explicit local alias', () => {
  assert.equal(
    createConfig({ LOCAL_HOSTNAME: 'Agentic-OS-Console' }).LOCAL_HOSTNAME,
    'agentic-os-console'
  );
  assert.equal(createConfig({ LOCAL_HOSTNAME: '' }).LOCAL_HOSTNAME, null);
  assert.equal(
    createConfig({ LOCAL_HOSTNAME: 'Agentic-OS-Console.LOCALHOST' }).LOCAL_HOSTNAME,
    'agentic-os-console.localhost'
  );
});

test('LOCAL_HOSTNAME rejects DNS names and malformed aliases', () => {
  for (const LOCAL_HOSTNAME of [
    'console.example.com',
    'console.localhost.example',
    'bad alias',
    '-leading-hyphen',
    'trailing-hyphen-',
    'a'.repeat(64),
  ]) {
    assert.throws(() => createConfig({ LOCAL_HOSTNAME }), /Invalid LOCAL_HOSTNAME/);
  }
});

test('proxy config defaults to off and accepts one exact DNS name with a long secret', () => {
  const off = createConfig({});
  assert.equal(off.PROXY_HOSTNAME, null);
  assert.equal(off.PROXY_SECRET, null);
  const on = createConfig({ PROXY_HOSTNAME: 'AOS-Console.home.arpa', PROXY_SECRET: 'k'.repeat(32) });
  assert.equal(on.PROXY_HOSTNAME, 'aos-console.home.arpa');
  assert.equal(on.HOST, '127.0.0.1');
});

test('proxy config rejects half-configured, malformed, and weak settings', () => {
  const secret = 'k'.repeat(32);
  assert.throws(() => createConfig({ PROXY_HOSTNAME: 'aos-console.home.arpa' }), /set together/);
  assert.throws(() => createConfig({ PROXY_SECRET: secret }), /set together/);
  for (const PROXY_HOSTNAME of ['single-label', '*.home.arpa', 'a b.home.arpa', 'console.localhost', 'x.-bad.arpa']) {
    assert.throws(() => createConfig({ PROXY_HOSTNAME, PROXY_SECRET: secret }), /Invalid PROXY_HOSTNAME/, PROXY_HOSTNAME);
  }
  assert.throws(
    () => createConfig({ PROXY_HOSTNAME: 'aos-console.home.arpa', PROXY_SECRET: 'short' }),
    /Invalid PROXY_SECRET/
  );
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

test('request hostname allowlist includes only loopback names and the configured alias', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', 'agentic-os-console']) {
    assert.equal(isAllowedLocalHostname(h, 'agentic-os-console'), true, h);
  }
  for (const h of ['evil.example', 'other-console', '', null]) {
    assert.equal(isAllowedLocalHostname(h, 'agentic-os-console'), false, String(h));
  }
  assert.equal(
    isAllowedLocalHostname(
      'agentic-os-console.localhost',
      'agentic-os-console.localhost'
    ),
    true
  );
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
