import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { sourceKind } from '../src/docs.js';

// Fixture repo (deterministic counts, not the live evolving repo).
let root;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'docs-fixture-'));
  const write = async (rel, text) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  };
  await write('AGENTS.md', '# Schema\n');
  await write(
    'wiki/page.md',
    '---\ntags: [alpha, beta]\nupdated: 2026-07-01\n---\n\n# Page\n\nBody text.\n'
  );
  await write('wiki/projects/proj.md', '# Proj\n');
  await write('wiki/notes.txt', 'not markdown — must not appear in the tree\n');
  await write('raw/examples/capture.md', 'Status: Draft\n\nCandid NDA-grade capture body.\n');
  await write('templates/t.md', '# T\n');
  await write('dashboards/d.md', '# D\n');
  await write('.claude/skills/aos-ingest/SKILL.md', '# Ingest\n');
  await write('secrets.md', 'outside the allowed roots\n');
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const app = () => createApp(createConfig({ REPO_ROOT: root }));
const appRawOn = () => createApp(createConfig({ REPO_ROOT: root, EXPOSE_RAW_CONTENT: 'true' }));
const get = (a, url) => request(a).get(url).set('Host', '127.0.0.1:3001');

function flatten(nodes, out = []) {
  for (const n of nodes) {
    out.push(n);
    if (n.children) flatten(n.children, out);
  }
  return out;
}

test('GET /api/docs/tree tags every node with the correct source kind', async () => {
  const res = await get(app(), '/api/docs/tree');
  assert.equal(res.status, 200);
  const all = flatten(res.body.roots);
  const byPath = Object.fromEntries(all.map((n) => [n.path, n]));

  assert.deepEqual(
    res.body.roots.map((node) => node.path),
    ['AGENTS.md', 'wiki', 'raw', 'templates', '.claude/skills']
  );
  assert.equal(byPath['AGENTS.md'].source, 'root');
  assert.equal(byPath['AGENTS.md'].type, 'file');
  assert.equal(byPath['wiki'].source, 'wiki');
  assert.equal(byPath['wiki/page.md'].source, 'wiki');
  assert.equal(byPath['wiki/projects'].type, 'dir');
  assert.equal(byPath['wiki/projects/proj.md'].source, 'wiki');
  assert.equal(byPath['raw/examples/capture.md'].source, 'raw');
  assert.equal(byPath['templates/t.md'].source, 'template');
  assert.equal(byPath['.claude/skills/aos-ingest/SKILL.md'].source, 'skill');
  assert.equal(byPath['dashboards'], undefined);
  assert.equal(byPath['dashboards/d.md'], undefined);
  assert.equal(sourceKind('dashboards/d.md'), null);
});

test('tree lists folders and .md files only, and omits missing roots', async () => {
  const res = await get(app(), '/api/docs/tree');
  const all = flatten(res.body.roots);
  assert.ok(!all.some((n) => n.path === 'wiki/notes.txt'), 'non-.md file leaked into the tree');
  assert.ok(!all.some((n) => n.path === 'secrets.md'), 'non-root file leaked into the tree');
  assert.ok(all.every((n) => n.type === 'dir' || n.name.endsWith('.md')));
});

test('GET /api/docs/file returns markdown + frontmatter + resolved paths', async () => {
  const res = await get(app(), '/api/docs/file?path=wiki/page.md');
  assert.equal(res.status, 200);
  assert.equal(res.body.path, 'wiki/page.md');
  assert.equal(res.body.absolutePath, path.join(root, 'wiki/page.md'));
  assert.equal(res.body.source, 'wiki');
  assert.deepEqual(res.body.frontmatter.tags, ['alpha', 'beta']);
  assert.ok(res.body.markdown.includes('# Page'));
  assert.ok(!res.body.markdown.includes('tags:'), 'frontmatter left inside the markdown body');
  assert.ok(res.body.mtime);
});

test('raw content is withheld by default (403, ADR-0005)', async () => {
  const res = await get(app(), '/api/docs/file?path=raw/examples/capture.md');
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'raw-content-hidden');
  assert.ok(!JSON.stringify(res.body).includes('Candid NDA-grade'), 'raw body leaked');
});

test('raw gating never leaks an existence oracle', async () => {
  const res = await get(app(), '/api/docs/file?path=raw/examples/nope.md');
  assert.equal(res.status, 403, 'missing raw path must gate (403), not 404');
});

test('raw content is returned with EXPOSE_RAW_CONTENT=true', async () => {
  const res = await get(appRawOn(), '/api/docs/file?path=raw/examples/capture.md');
  assert.equal(res.status, 200);
  assert.ok(res.body.markdown.includes('Candid NDA-grade'));
  assert.equal(res.body.source, 'raw');
});

test('raw metrics are unaffected by the content gate', async () => {
  const res = await get(app(), '/api/metrics');
  assert.equal(res.status, 200);
  assert.equal(res.body.rawN, 1);
  assert.equal(res.body.capN, 1);
  assert.equal(res.body.draftN, 1);
});

test('path traversal, absolute, and outside-root paths are rejected (400)', async () => {
  for (const p of [
    '../../etc/passwd',
    'wiki/../raw/examples/capture.md',
    '/etc/passwd',
    'secrets.md',
    'platform/server/src/config.js',
  ]) {
    const res = await get(app(), `/api/docs/file?path=${encodeURIComponent(p)}`);
    assert.equal(res.status, 400, p);
    assert.equal(res.body.error, 'unsafe-path', p);
  }
  const missing = await get(app(), '/api/docs/file');
  assert.equal(missing.status, 400);
});

test('a missing doc inside an allowed root is 404, a directory is 404', async () => {
  assert.equal((await get(app(), '/api/docs/file?path=wiki/nope.md')).status, 404);
  assert.equal((await get(app(), '/api/docs/file?path=wiki')).status, 404);
});
