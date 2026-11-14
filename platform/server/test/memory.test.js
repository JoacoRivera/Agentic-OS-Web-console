import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';

// Fixture repo: the synthetic recall corpus (test/recall-corpus.json, shared with
// recall.test.js) plus a raw/ capture that must never surface — not the live wiki.
let root;
let bigRoot;

const writeTree = async (base, files) => {
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(base, rel)), { recursive: true });
    await fs.writeFile(path.join(base, rel), text);
  }
};

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-fixture-'));
  const { pages } = JSON.parse(await fs.readFile(new URL('./recall-corpus.json', import.meta.url), 'utf8'));
  await writeTree(root, pages);
  await writeTree(root, {
    'raw/examples/secret.md':
      '---\ntags: [code-review, maintenance]\n---\n\n# Secret Maintenance Pass\n\n> Should never surface via memory query.\n\nCandid NDA-grade capture body about the lighthouse.\n',
  });

  // > RESULT_LIMIT pages sharing one word, for the cap.
  bigRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-big-'));
  const big = { 'wiki/index.md': '---\ntags: []\n---\n# Index\n' };
  for (let i = 0; i < 55; i += 1) {
    big[`wiki/p${String(i).padStart(2, '0')}.md`] = `---\ntags: [lantern]\n---\n# Page ${i}\n\n> Lantern page.\n\n${'filler '.repeat(i)}lantern\n`;
  }
  await writeTree(bigRoot, big);
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(bigRoot, { recursive: true, force: true });
});

const app = () => createApp(createConfig({ REPO_ROOT: root }));
const appRawOn = () => createApp(createConfig({ REPO_ROOT: root, EXPOSE_RAW_CONTENT: 'true' }));
const get = (a, url) => request(a).get(url).set('Host', '127.0.0.1:3001');
const q = (topic, extra = '') => `/api/memory/query?topic=${encodeURIComponent(topic)}${extra}`;

// ---- step 1: BM25F question-first recall ------------------------------------

// Expected values from the real wiki_recall.py on this corpus (see the header of the
// REFERENCE table in recall.test.js for the exact command and memory-repo commit).
const MAINTENANCE = {
  default: [
    ['wiki/workflows/maintenance-pass.md', 6.1],
    ['wiki/examples/sample.md', 2.6],
    ['wiki/examples-of-maintenance.md', 2.6],
    ['wiki/workflows/evals/results/2026-01-01.md', 2.5],
  ],
  history: [
    ['wiki/workflows/maintenance-pass.md', 6.1],
    ['wiki/examples/sample.md', 5.1],
    ['wiki/workflows/evals/results/2026-01-01.md', 5.1],
    ['wiki/examples-of-maintenance.md', 2.6],
  ],
};

const assertRanked = (body, expected) => {
  assert.deepEqual(body.results.map((r) => r.path), expected.map(([p]) => p));
  body.results.forEach((r, i) => assert.ok(Math.abs(r.score - expected[i][1]) <= 0.05 + 1e-9, `${r.path}: ${r.score}`));
};

test('GET /api/memory/query ranks pages by BM25F like wiki_recall.py, with the response shape the view reads', async () => {
  const res = await get(app(), q('how does the maintenance pass work?'));
  assert.equal(res.status, 200);
  assert.equal(res.body.query, 'how does the maintenance pass work?');
  assert.equal(res.body.pagesIndexed, 19);
  assert.equal(res.body.pagesMatched, 4);
  assert.equal(res.body.includeHistory, false);
  assert.equal(res.body.truncated, false);
  assertRanked(res.body, MAINTENANCE.default);
  const top = res.body.results[0];
  assert.equal(top.title, 'Maintenance Pass');
  assert.deepEqual(top.tags, ['maintenance', 'wiki-lint', 'cadence']);
  assert.equal(typeof top.score, 'number');
  assert.equal(top.history, false);
  assert.equal(res.body.results.find((r) => r.path === 'wiki/examples/sample.md').history, true);
  assert.ok(res.body.tagRecall && Array.isArray(res.body.tagRecall.results));
  assert.ok(res.body.generatedAt);
});

test('includeHistory=1 scores eval results and examples at full weight; other values leave it off', async () => {
  const on = await get(app(), q('how does the maintenance pass work?', '&includeHistory=1'));
  assert.equal(on.body.includeHistory, true);
  assertRanked(on.body, MAINTENANCE.history);
  const alsoOn = await get(app(), q('how does the maintenance pass work?', '&includeHistory=true'));
  assert.equal(alsoOn.body.includeHistory, true);
  const off = await get(app(), q('how does the maintenance pass work?', '&includeHistory=yes'));
  assert.equal(off.body.includeHistory, false);
  assertRanked(off.body, MAINTENANCE.default);
});

test('a question finds a page by a body word no tag carries (tag-only recall finds nothing)', async () => {
  const res = await get(app(), q('lighthouse'));
  assert.equal(res.status, 200);
  assertRanked(res.body, [['wiki/notes/body-only.md', 2.8]]);
  assert.deepEqual(res.body.tagRecall.matchedTags, []);
  assert.deepEqual(res.body.tagRecall.results, []);
});

test('a page with invalid YAML frontmatter is indexed (no tags) and findable; a page with no block is not', async () => {
  const res = await get(app(), q('compass'));
  assert.equal(res.status, 200);
  assertRanked(res.body, [
    ['wiki/notes/broken.md', 2.2],
    ['wiki/notes/no-h1.md', 2],
  ]);
  const broken = res.body.results[0];
  assert.equal(broken.title, 'Broken Frontmatter');
  assert.deepEqual(broken.tags, []);
  assert.equal(res.body.results[1].title, 'no-h1'); // no H1 → filename stem
  assert.ok(!res.body.results.some((r) => r.path === 'wiki/notes/nofm.md'));
});

test('a CRLF page is indexed like its LF twin', async () => {
  const res = await get(app(), q('harbor'));
  assertRanked(res.body, [
    ['wiki/notes/crlf.md', 4],
    ['wiki/notes/lf.md', 4],
  ]);
  assert.equal(res.body.results[0].score, res.body.results[1].score);
  assert.equal(res.body.results[0].summary, 'Ships in the harbor, counted daily.');
});

test('the summary is the whole blockquote, truncated at 160 characters like the reference prints it', async () => {
  const res = await get(app(), q('which checks does wiki lint run?'));
  const lint = res.body.results.find((r) => r.path === 'wiki/concepts/wiki-lint.md');
  assert.ok(lint.summary.endsWith('…'));
  assert.ok(lint.summary.length <= 161);
  assert.ok(lint.summary.startsWith('Wiki lint checks frontmatter, index coverage'));
});

test('pagesMatched counts every matching page before the 50-result cap', async () => {
  const res = await get(createApp(createConfig({ REPO_ROOT: bigRoot })), q('lantern'));
  assert.equal(res.status, 200);
  assert.equal(res.body.pagesIndexed, 55);
  assert.equal(res.body.pagesMatched, 55);
  assert.equal(res.body.results.length, 50);
  assert.equal(res.body.truncated, true);
  assert.equal(res.body.tagRecall.results.length, 50);
  assert.equal(res.body.tagRecall.truncated, true);
});

test('a stopwords-only question is an honest empty BM25 result; nothing searchable at all is a 400', async () => {
  const stop = await get(app(), q('how is it'));
  assert.equal(stop.status, 200);
  assert.deepEqual(stop.body.results, []);
  assert.equal(stop.body.pagesMatched, 0);

  const none = await get(app(), q('zzqxv'));
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.results, []);
  assert.deepEqual(none.body.tagRecall.results, []);

  for (const topic of ['', '???', 'é']) {
    const res = await get(app(), q(topic));
    assert.equal(res.status, 400, JSON.stringify(topic));
    assert.equal(res.body.error, 'bad-query');
  }
  const missing = await get(app(), '/api/memory/query');
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'bad-query');
});

// ---- step 2: tag recall -----------------------------------------------------

test('tag recall discovers tags by substring and ranks matching pages', async () => {
  const res = await get(app(), q('review'));
  assert.equal(res.status, 200);
  const tags = res.body.tagRecall;
  assert.deepEqual(tags.matchedTags.map((t) => t.tag), ['code-review']);
  // Tied match count (1 each) — alphabetical tiebreak.
  assert.deepEqual(tags.results.map((r) => r.path), ['wiki/projects/alpha.md', 'wiki/workflows/review.md']);
  for (const r of tags.results) {
    assert.deepEqual(r.matchedTags, ['code-review']);
    assert.ok(r.title);
    assert.ok(r.summary);
  }
});

test('tag recall ranks a page higher when it carries more matching tags', async () => {
  const res = await get(app(), q('code review checklist'));
  assert.equal(res.body.tagRecall.results[0].path, 'wiki/workflows/review.md');
  assert.equal(res.body.tagRecall.results[0].matchedTags.length, 2);
  assertRanked(res.body, [
    ['wiki/workflows/review.md', 11.7],
    ['wiki/projects/alpha.md', 4.6],
  ]);
});

test('tag recall: an exact tag finds its page', async () => {
  const res = await get(app(), q('alpha-project'));
  assert.deepEqual(res.body.tagRecall.results.map((r) => r.path), ['wiki/projects/alpha.md']);
});

test('tag recall with no matching tags is an honest empty result, not an error', async () => {
  const res = await get(app(), q('nonexistent-topic-xyz'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.tagRecall.matchedTags, []);
  assert.deepEqual(res.body.tagRecall.results, []);
  assert.deepEqual(res.body.results, []);
});

test('a scalar tags value is not a list: it yields no tag', async () => {
  const res = await get(app(), q('foo-scalar'));
  assert.deepEqual(res.body.tagRecall.matchedTags, []);
  const page = res.body.results.find((r) => r.path === 'wiki/notes/scalar-tags.md');
  assert.ok(page, 'still found by its body text');
  assert.deepEqual(page.tags, []);
});

test('tag recall deduplicates a page\'s duplicate tags (case-insensitively) before counting and ranking', async () => {
  const res = await get(app(), q('dup-tag'));
  const tags = res.body.tagRecall;
  assert.deepEqual(tags.matchedTags, [{ tag: 'dup-tag', count: 1 }]);
  assert.equal(tags.results.length, 1);
  assert.equal(tags.results[0].path, 'wiki/projects/dup.md');
  assert.deepEqual(tags.results[0].matchedTags, ['dup-tag']);
  // The BM25 result lists the page's tags as written, like the reference.
  assert.deepEqual(res.body.results.find((r) => r.path === 'wiki/projects/dup.md').tags, ['dup-tag', 'Dup-Tag', 'DUP-TAG']);
});

// ---- boundaries -------------------------------------------------------------

test('GET /api/memory/query never surfaces raw/ pages, regardless of EXPOSE_RAW_CONTENT', async () => {
  for (const topic of ['review', 'maintenance pass', 'lighthouse']) {
    const off = await get(app(), q(topic));
    const on = await get(appRawOn(), q(topic));
    for (const body of [off.body, on.body]) {
      assert.ok(!body.results.some((r) => r.path.startsWith('raw/')), topic);
      assert.ok(!body.tagRecall.results.some((r) => r.path.startsWith('raw/')), topic);
    }
    // The raw page must not leak an extra matched page/count either.
    assert.equal(on.body.pagesIndexed, off.body.pagesIndexed);
    assert.equal(on.body.pagesMatched, off.body.pagesMatched);
    assert.equal(on.body.tagRecall.results.length, off.body.tagRecall.results.length);
    assert.deepEqual(on.body.tagRecall.matchedTags, off.body.tagRecall.matchedTags);
  }
});

test('index.md, log.md and _template.md are excluded from both steps even though they match', async () => {
  const res = await get(app(), q('index-tag log-tag maintenance pass catalog chronology template'));
  // index-tag / log-tag exist only on the excluded pages, so they are not in the vocabulary.
  assert.deepEqual(res.body.tagRecall.matchedTags.map((t) => t.tag), ['maintenance']);
  const excluded = new Set(['wiki/index.md', 'wiki/log.md', 'wiki/_template.md']);
  assert.ok(!res.body.results.some((r) => excluded.has(r.path)));
});

test('the memory route keeps the Host-header defence', async () => {
  const res = await request(app()).get(q('maintenance')).set('Host', 'evil.example');
  assert.equal(res.status, 403);
});
