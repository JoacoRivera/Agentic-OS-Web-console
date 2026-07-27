import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';

// Fixture repo (deterministic tags/pages, not the live evolving wiki).
let root;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-fixture-'));
  const write = async (rel, text) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  };
  await write(
    'wiki/index.md',
    '---\ntags: [index-tag]\n---\n\n# Index\n\nCatalog — excluded from recall.\n'
  );
  await write('wiki/log.md', '---\ntags: [log-tag]\n---\n\n# Log\n\nChronology — excluded from recall.\n');
  await write(
    'wiki/projects/alpha.md',
    '---\ntags: [alpha-project, code-review]\nupdated: 2026-07-01\n---\n\n# Alpha Project\n\n> One-line summary of the alpha project.\n\nBody text.\n'
  );
  await write(
    'wiki/workflows/review.md',
    '---\ntags: [code-review, checklist]\nupdated: 2026-07-02\n---\n\n# Code Review Workflow\n\n> How code review is run here.\n\nBody text.\n'
  );
  await write('wiki/notes/misc.md', '---\nupdated: 2026-07-03\n---\n\n# Misc\n\nNo tags at all.\n');
  // Malformed frontmatter must not crash recall — just isn't indexable.
  await write('wiki/notes/broken.md', '---\ntags: [oops\n---\n\n# Broken\n');
  // No YAML frontmatter block at all (not even an empty one) — must be
  // skipped entirely, not indexed with empty tags (mirrors wiki-tags.py's
  // frontmatter() regex, which requires the file to start with "---").
  await write(
    'wiki/notes/nofm.md',
    '# No Frontmatter\n\n> Should never be indexed.\n\ntags: [no-frontmatter-body-tag]\n'
  );
  // Duplicate tags on one page, differing only by case — must not inflate
  // the tag's vocabulary count or the page's matchCount.
  await write(
    'wiki/projects/dup.md',
    '---\ntags: [dup-tag, Dup-Tag, DUP-TAG]\n---\n\n# Dup\n\n> Page with a duplicated tag.\n\nBody text.\n'
  );
  await write(
    'raw/examples/secret.md',
    '---\ntags: [code-review]\n---\n\n# Secret\n\n> Should never surface via memory query.\n\nCandid NDA-grade capture body.\n'
  );
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const app = () => createApp(createConfig({ REPO_ROOT: root }));
const appRawOn = () => createApp(createConfig({ REPO_ROOT: root, EXPOSE_RAW_CONTENT: 'true' }));
const get = (a, url) => request(a).get(url).set('Host', '127.0.0.1:3001');

test('GET /api/memory/query discovers tags by substring and ranks matching pages', async () => {
  const res = await get(app(), '/api/memory/query?topic=review');
  assert.equal(res.status, 200);
  assert.equal(res.body.query, 'review');
  assert.deepEqual(
    res.body.matchedTags.map((t) => t.tag),
    ['code-review']
  );
  assert.equal(res.body.results.length, 2);
  const paths = res.body.results.map((r) => r.path);
  // Tied match count (1 each) — alphabetical tiebreak.
  assert.deepEqual(paths, ['wiki/projects/alpha.md', 'wiki/workflows/review.md']);
  for (const r of res.body.results) {
    assert.deepEqual(r.matchedTags, ['code-review']);
    assert.ok(r.title);
    assert.ok(r.summary);
  }
});

test('GET /api/memory/query ranks a page higher when it carries more matching tags', async () => {
  const res = await get(app(), '/api/memory/query?topic=code review checklist');
  assert.equal(res.status, 200);
  assert.equal(res.body.results[0].path, 'wiki/workflows/review.md');
  assert.equal(res.body.results[0].matchedTags.length, 2);
});

test('GET /api/memory/query exact tag match finds its page', async () => {
  const res = await get(app(), '/api/memory/query?topic=alpha-project');
  assert.equal(res.status, 200);
  assert.equal(res.body.results.length, 1);
  assert.equal(res.body.results[0].path, 'wiki/projects/alpha.md');
});

test('GET /api/memory/query with no matching tags is an honest empty result, not an error', async () => {
  const res = await get(app(), '/api/memory/query?topic=nonexistent-topic-xyz');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.matchedTags, []);
  assert.deepEqual(res.body.results, []);
});

test('GET /api/memory/query rejects an empty or unsearchable topic', async () => {
  const empty = await get(app(), '/api/memory/query?topic=');
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, 'bad-query');

  const missing = await get(app(), '/api/memory/query');
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'bad-query');

  const punctOnly = await get(app(), `/api/memory/query?topic=${encodeURIComponent('???')}`);
  assert.equal(punctOnly.status, 400);
  assert.equal(punctOnly.body.error, 'bad-query');
});

test('GET /api/memory/query never surfaces raw/ pages, regardless of EXPOSE_RAW_CONTENT', async () => {
  const withRawOff = await get(app(), '/api/memory/query?topic=review');
  assert.ok(!withRawOff.body.results.some((r) => r.path.startsWith('raw/')));

  const withRawOn = await get(appRawOn(), '/api/memory/query?topic=review');
  assert.ok(!withRawOn.body.results.some((r) => r.path.startsWith('raw/')));
  // The raw page's tag still must not leak an extra matched page/count.
  assert.equal(withRawOn.body.results.length, withRawOff.body.results.length);
});

test('GET /api/memory/query excludes index.md and log.md from the tag index even though they carry matching tags', async () => {
  const res = await get(app(), '/api/memory/query?topic=index-tag log-tag');
  assert.deepEqual(res.body.matchedTags, []);
  assert.deepEqual(res.body.results, []);
});

test('GET /api/memory/query tolerates malformed frontmatter without crashing (page just isn\'t indexed)', async () => {
  const res = await get(app(), '/api/memory/query?topic=oops');
  assert.equal(res.status, 200);
  assert.ok(!res.body.results.some((r) => r.path === 'wiki/notes/broken.md'));
});

test('GET /api/memory/query skips pages with no YAML frontmatter block at all', async () => {
  const res = await get(app(), '/api/memory/query?topic=no-frontmatter-body-tag');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.matchedTags, []);
  assert.deepEqual(res.body.results, []);
});

test('GET /api/memory/query deduplicates a page\'s duplicate tags (case-insensitively) before counting and ranking', async () => {
  const res = await get(app(), '/api/memory/query?topic=dup-tag');
  assert.equal(res.status, 200);
  // Vocabulary count for the tag must be 1 (one page), not 3 (one per
  // duplicate occurrence).
  assert.deepEqual(res.body.matchedTags, [{ tag: 'dup-tag', count: 1 }]);
  assert.equal(res.body.results.length, 1);
  assert.equal(res.body.results[0].path, 'wiki/projects/dup.md');
  // matchedTags for the page itself must also be deduplicated, not
  // ['dup-tag', 'Dup-Tag', 'DUP-TAG'].
  assert.deepEqual(res.body.results[0].matchedTags, ['dup-tag']);
});
