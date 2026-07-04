import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';

// Fixture repo exercising every link form backlinks must resolve.
let root;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'search-fixture-'));
  const write = async (rel, text) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  };
  await write('AGENTS.md', '# Schema\n\nSee [manual ops](wiki/workflows/manual-operations.md).\n');
  await write(
    'wiki/workflows/manual-operations.md',
    '# Manual operations\n\nThe zebra-token lives here.\n'
  );
  await write(
    'wiki/workflows/task-modes.md',
    '# Task modes\n\nRelative link: [manual ops](manual-operations.md).\n' +
      'Anchor form: [session close](manual-operations.md#session-close).\n'
  );
  await write(
    'wiki/projects/proj.md',
    '# Proj\n\nUp-dir relative: [ops](../workflows/manual-operations.md).\n' +
      'External: [example](https://example.com/manual-operations.md).\n'
  );
  await write(
    'dashboards/hud.md',
    '# HUD\n\nWikilink: [[manual-operations]] and heading form [[manual-operations#session-close]]\n' +
      'Alias form: [[manual-operations|the runbook]]. Unrelated: [[other-page]].\n'
  );
  await write('wiki/collisions/duplicate.md', '# Duplicate A\n\n');
  await write('dashboards/duplicate.md', '# Duplicate B\n\n');
  await write('wiki/collisions/ambiguous-link.md', '# Ambiguous\n\n[[duplicate]]\n');
  await write(
    'raw/examples/capture.md',
    'Status: Draft\n\nzebra-token appears in a candid raw body.\n' +
      'Raw cites the runbook: [[manual-operations]].\n'
  );
  await write('raw/examples/zebra-token-note.md', 'Status: Draft\n\nSecret raw body.\n');
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const app = () => createApp(createConfig({ REPO_ROOT: root }));
const appRawOn = () => createApp(createConfig({ REPO_ROOT: root, EXPOSE_RAW_CONTENT: 'true' }));
const get = (a, url) => request(a).get(url).set('Host', '127.0.0.1:3001');

// ---- search ----

test('search finds docs by filename (path substring)', async () => {
  const res = await get(app(), '/api/docs/search?q=manual-operations');
  assert.equal(res.status, 200);
  const paths = res.body.results.map((r) => r.path);
  assert.ok(paths.includes('wiki/workflows/manual-operations.md'));
  const hit = res.body.results.find((r) => r.path === 'wiki/workflows/manual-operations.md');
  assert.equal(hit.nameMatch, true);
});

test('search finds docs by content with line snippets', async () => {
  const res = await get(app(), '/api/docs/search?q=zebra-token');
  assert.equal(res.status, 200);
  const hit = res.body.results.find((r) => r.path === 'wiki/workflows/manual-operations.md');
  assert.ok(hit, 'content match missing');
  assert.equal(hit.nameMatch, false);
  assert.ok(hit.contentMatches >= 1);
  assert.ok(hit.snippets[0].text.includes('zebra-token'));
  assert.ok(hit.snippets[0].line > 0);
});

test('search is case-insensitive', async () => {
  const res = await get(app(), '/api/docs/search?q=ZEBRA-Token');
  assert.ok(res.body.results.some((r) => r.path === 'wiki/workflows/manual-operations.md'));
});

test('raw bodies never match nor leak snippets while the gate is off (ADR-0005)', async () => {
  const res = await get(app(), '/api/docs/search?q=zebra-token');
  assert.equal(res.status, 200);
  const rawContentHit = res.body.results.find((r) => r.path === 'raw/examples/capture.md');
  assert.equal(rawContentHit, undefined, 'raw content match leaked');
  // Raw *names* are metadata and still match by filename — with zero snippets.
  const rawNameHit = res.body.results.find((r) => r.path === 'raw/examples/zebra-token-note.md');
  assert.ok(rawNameHit, 'raw filename match should still appear');
  assert.equal(rawNameHit.contentMatches, 0);
  assert.deepEqual(rawNameHit.snippets, []);
  assert.ok(!JSON.stringify(res.body).includes('Secret raw body'), 'raw body leaked');
});

test('raw bodies and snippets appear with EXPOSE_RAW_CONTENT=true', async () => {
  const res = await get(appRawOn(), '/api/docs/search?q=zebra-token');
  const hit = res.body.results.find((r) => r.path === 'raw/examples/capture.md');
  assert.ok(hit, 'raw content match missing with the gate on');
  assert.ok(hit.snippets[0].text.includes('zebra-token'));
});

test('missing or empty q is rejected (400)', async () => {
  assert.equal((await get(app(), '/api/docs/search')).status, 400);
  assert.equal((await get(app(), '/api/docs/search?q=%20')).status, 400);
});

// ---- backlinks ----

test('backlinks resolve relative, up-dir, root-relative, anchor, and wikilink forms', async () => {
  const res = await get(
    app(),
    '/api/docs/backlinks?path=wiki/workflows/manual-operations.md'
  );
  assert.equal(res.status, 200);
  const byPath = Object.fromEntries(res.body.backlinks.map((b) => [b.path, b]));

  assert.ok(byPath['AGENTS.md'], 'root-relative repo link not resolved');
  assert.ok(byPath['wiki/workflows/task-modes.md'], 'same-dir relative link not resolved');
  // task-modes has a plain relative link + a #heading anchor link.
  assert.equal(byPath['wiki/workflows/task-modes.md'].count, 2);
  assert.ok(byPath['wiki/projects/proj.md'], '../ relative link not resolved');
  // proj.md's external https link must not count as a second hit.
  assert.equal(byPath['wiki/projects/proj.md'].count, 1);
  assert.ok(byPath['dashboards/hud.md'], 'wikilink not resolved');
  // [[manual-operations]] + [[manual-operations#session-close]] + alias form.
  assert.equal(byPath['dashboards/hud.md'].count, 3);
});

test('a doc with no inbound links has no backlinks', async () => {
  const res = await get(app(), '/api/docs/backlinks?path=wiki/projects/proj.md');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.backlinks, []);
});

test('raw files are not backlink sources while the gate is off, and are with it on', async () => {
  const off = await get(app(), '/api/docs/backlinks?path=wiki/workflows/manual-operations.md');
  assert.ok(!off.body.backlinks.some((b) => b.source === 'raw'), 'raw source leaked');

  const on = await get(appRawOn(), '/api/docs/backlinks?path=wiki/workflows/manual-operations.md');
  assert.ok(on.body.backlinks.some((b) => b.path === 'raw/examples/capture.md'));
});

test('wikilink backlinks do not resolve ambiguous basename collisions', async () => {
  const res = await get(app(), '/api/docs/backlinks?path=wiki/collisions/duplicate.md');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.backlinks, []);
});

test('backlinks rejects unsafe paths (400)', async () => {
  for (const p of ['../../etc/passwd', '/etc/passwd', 'secrets.md']) {
    const res = await get(app(), `/api/docs/backlinks?path=${encodeURIComponent(p)}`);
    assert.equal(res.status, 400, p);
    assert.equal(res.body.error, 'unsafe-path', p);
  }
  assert.equal((await get(app(), '/api/docs/backlinks')).status, 400);
});
