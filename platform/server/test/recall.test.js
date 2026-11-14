import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  tokenize,
  fullSummary,
  textField,
  pathField,
  pageTitle,
  pyLines,
  isHistory,
  comparePaths,
  Bm25Index,
  recall,
  BM25_K1,
} from '../src/recall.js';
import { loadWikiPages } from '../src/memory.js';

// ---- tokenizer -------------------------------------------------------------

test('tokenize lowercases, folds accents and drops 1-char tokens and EN/ES/DE stopwords', () => {
  assert.deepEqual(tokenize('Revisión ÜBER Straße'), ['revision', 'uber', 'stra']); // ß is not [a-z0-9], as in Python
  assert.deepEqual(tokenize('how does the X work'), ['work']);
  assert.deepEqual(tokenize('cual es la revisión del proceso'), ['revision', 'proceso']);
  assert.deepEqual(tokenize('wie ist das nicht'), []);
  assert.deepEqual(tokenize('a b c 7'), []);
});

test('tokenize keeps dotted versions whole and adds major.minor for three-part versions', () => {
  assert.deepEqual(tokenize('4.8'), ['4.8']);
  assert.deepEqual(tokenize('4.5.2 vs 4.8'), ['4.5.2', '4.5', 'vs', '4.8']);
  assert.deepEqual(tokenize('a.b'), []); // letters split on '.', each then too short
  assert.deepEqual(tokenize('foo.bar'), ['foo', 'bar']);
  assert.deepEqual(tokenize('code-review'), ['code', 'review']);
});

test('tokenize folds only combining marks (unicodedata.combining != 0), keeping spacing marks', () => {
  // U+0301 COMBINING ACUTE (ccc 230) is folded away; U+093E DEVANAGARI VOWEL SIGN AA is a
  // spacing mark with ccc 0 — Python keeps it, so the port must too (it is not [a-z0-9],
  // so it splits the token).
  assert.deepEqual(tokenize('café'), ['cafe']);
  assert.deepEqual(tokenize('abाcd'), ['ab', 'cd']);
  // U+0345 (ccc 240) is itself combining.
  assert.deepEqual(tokenize('abͅcd'), ['abcd']);
});

test('pyLines splits like Python str.splitlines()', () => {
  assert.deepEqual(pyLines(''), []);
  assert.deepEqual(pyLines('a\n'), ['a']);
  assert.deepEqual(pyLines('a\n\nb'), ['a', '', 'b']);
  assert.deepEqual(pyLines('a\r\nb\rc d\x85e\x0cf'), ['a', 'b', 'c', 'd', 'e', 'f']);
});

// ---- fields ----------------------------------------------------------------

test('fullSummary takes the whole first blockquote run and stops at the first non-> line', () => {
  const body = '\n# T\n\n>  First line,\n> second   line.\nplain\n> later quote\n';
  assert.equal(fullSummary(body), 'First line, second line.');
  assert.equal(fullSummary('# T\n\nno quote\n'), '');
});

test('textField removes exactly the H1 and the first blockquote, leaving ## headings and later quotes', () => {
  const body = '\n# Title\n\n> sum one\n> sum two\n\n## Section\n\n> later quote\ntext\n';
  assert.equal(textField(body), '\n\n\n## Section\n\n> later quote\ntext');
  // '#tag' (no space) is not a title line.
  assert.equal(textField('#tag line\n# Real\nrest'), '#tag line\nrest');
});

test('pageTitle uses the first H1 and falls back to the filename stem', () => {
  assert.equal(pageTitle('\n## Sub\n# Main Title  \n', 'notes/x.md'), 'Main Title');
  assert.equal(pageTitle('no heading', 'notes/no-h1.md'), 'no-h1');
  // Python re.M only breaks lines on \n: a title after U+2028 is not at a line start.
  assert.equal(pageTitle('x # Hidden', 'notes/y.md'), 'y');
});

test('pathField drops the wiki/ prefix and .md suffix', () => {
  assert.equal(pathField('wiki/workflows/maintenance-pass.md'), 'workflows/maintenance-pass');
});

// ---- BM25F -----------------------------------------------------------------

const page = (p, title, body, tags = [], summary = '') => ({ path: p, title, tags, summary, body });

test('BM25F score matches the formula written out by hand (title hit outranks a text hit)', () => {
  const pages = [
    page('wiki/a.md', 'Kite', '# Kite\n'), // kite in title only; text empty
    page('wiki/b.md', 'Notes', '# Notes\n\nkite flying kite'), // kite twice in text (len 3)
    page('wiki/c.md', 'Other', '# Other\n\nnothing here'), // text len 2
  ];
  const ranked = recall('kite', pages);
  const idf = Math.log(1 + (3 - 2 + 0.5) / (2 + 0.5)); // N = 3, df = 2
  const sat = (tf) => (idf * tf * (BM25_K1 + 1)) / (tf + BM25_K1);
  // a: title weight 3, len 1 = avg 1 → pseudo-tf 3.
  const a = sat(3);
  // b: text weight 1, tf 2, len 3, avg (0 + 3 + 2) / 3 → 2 / (0.7 + 0.3 · 1.8).
  const b = sat(2 / (1 - 0.3 + 0.3 * (3 / (5 / 3))));
  assert.deepEqual(ranked.map((r) => r.page.path), ['wiki/a.md', 'wiki/b.md', 'wiki/c.md']);
  assert.ok(Math.abs(ranked[0].score - a) < 1e-12);
  assert.ok(Math.abs(ranked[1].score - b) < 1e-12);
  assert.equal(ranked[2].score, 0); // a term absent from the page scores 0
});

test('BM25F document frequency counts a page once when the term is in two fields', () => {
  const index = new Bm25Index({
    'wiki/a.md': { title: ['kite'], text: ['kite', 'kite'] },
    'wiki/b.md': { title: ['other'], text: ['words'] },
  });
  assert.equal(index.idf.get('kite'), Math.log(1 + (2 - 1 + 0.5) / (1 + 0.5)));
  assert.equal(index.score(['absent'], 'wiki/a.md'), 0);
});

test('history pages are halved by default and scored fully with includeHistory', () => {
  assert.ok(isHistory('wiki/workflows/evals/results/x.md'));
  assert.ok(isHistory('wiki/examples/y.md'));
  assert.ok(!isHistory('wiki/examples-of-x.md'));
  const pages = [page('wiki/examples/y.md', 'Kite', '# Kite\n'), page('wiki/z.md', 'Kite', '# Kite\n')];
  const [full, half] = [recall('kite', pages, { includeHistory: true }), recall('kite', pages)];
  const fullY = full.find((r) => r.page.path === 'wiki/examples/y.md');
  const halfY = half.find((r) => r.page.path === 'wiki/examples/y.md');
  assert.equal(halfY.score, fullY.score * 0.5);
  assert.equal(halfY.history, true);
  assert.deepEqual(half.map((r) => r.page.path), ['wiki/z.md', 'wiki/examples/y.md']);
});

test('equal scores tie-break by code-point path order, not locale', () => {
  const pages = [page('wiki/a.md', 'Kite', '# Kite\n'), page('wiki/B.md', 'Kite', '# Kite\n')];
  assert.deepEqual(recall('kite', pages).map((r) => r.page.path), ['wiki/B.md', 'wiki/a.md']);
  assert.equal(comparePaths('wiki/\u{1F600}.md', 'wiki/￿.md'), 1); // astral sorts after the BMP
});

// ---- pinned against the reference ------------------------------------------
//
// Expected values were produced by the real reference implementation, run once by hand
// on this synthetic corpus written to a temp dir outside the repo (memory repo commit
// 1905a94, Python 3.14.4, PyYAML 6.0.3):
//
//   python3 ~/projects/agentic-os/scripts/wiki_recall.py --root <tmp> --top 100000 [--include-history] "<q>"
//
// `indexed` / `matched` are its "pages indexed" / "pages sharing a word with the question"
// lines, `ranked` its hits in order with the one-decimal score it prints. The tests never
// run Python; the corpus is test/recall-corpus.json (synthetic).
const REFERENCE = [
  { q: "how does the maintenance pass work?", includeHistory: false, indexed: 19, matched: 4, ranked: [["wiki/workflows/maintenance-pass.md", 6.1], ["wiki/examples/sample.md", 2.6], ["wiki/examples-of-maintenance.md", 2.6], ["wiki/workflows/evals/results/2026-01-01.md", 2.5]] },
  { q: "how does the maintenance pass work?", includeHistory: true, indexed: 19, matched: 4, ranked: [["wiki/workflows/maintenance-pass.md", 6.1], ["wiki/examples/sample.md", 5.1], ["wiki/workflows/evals/results/2026-01-01.md", 5.1], ["wiki/examples-of-maintenance.md", 2.6]] },
  { q: "which checks does wiki lint run?", includeHistory: false, indexed: 19, matched: 5, ranked: [["wiki/concepts/wiki-lint.md", 11.7], ["wiki/workflows/maintenance-pass.md", 7.3], ["wiki/notes/lint-mention.md", 4], ["wiki/workflows/review.md", 2.1], ["wiki/workflows/evals/results/2026-01-01.md", 2]] },
  { q: "which checks does wiki lint run?", includeHistory: true, indexed: 19, matched: 5, ranked: [["wiki/concepts/wiki-lint.md", 11.7], ["wiki/workflows/maintenance-pass.md", 7.3], ["wiki/notes/lint-mention.md", 4], ["wiki/workflows/evals/results/2026-01-01.md", 4], ["wiki/workflows/review.md", 2.1]] },
  { q: "runtime 4.5 vs 4.8", includeHistory: false, indexed: 19, matched: 2, ranked: [["wiki/tools/runtime.md", 8.5], ["wiki/tools/legacy.md", 8.2]] },
  { q: "runtime 4.5 vs 4.8", includeHistory: true, indexed: 19, matched: 2, ranked: [["wiki/tools/runtime.md", 8.5], ["wiki/tools/legacy.md", 8.2]] },
  { q: "revision uber", includeHistory: false, indexed: 19, matched: 1, ranked: [["wiki/notes/revision.md", 9]] },
  { q: "revision uber", includeHistory: true, indexed: 19, matched: 1, ranked: [["wiki/notes/revision.md", 9]] },
  { q: "lighthouse", includeHistory: false, indexed: 19, matched: 1, ranked: [["wiki/notes/body-only.md", 2.8]] },
  { q: "lighthouse", includeHistory: true, indexed: 19, matched: 1, ranked: [["wiki/notes/body-only.md", 2.8]] },
  { q: "harbor", includeHistory: false, indexed: 19, matched: 2, ranked: [["wiki/notes/crlf.md", 4], ["wiki/notes/lf.md", 4]] },
  { q: "harbor", includeHistory: true, indexed: 19, matched: 2, ranked: [["wiki/notes/crlf.md", 4], ["wiki/notes/lf.md", 4]] },
  { q: "compass", includeHistory: false, indexed: 19, matched: 2, ranked: [["wiki/notes/broken.md", 2.2], ["wiki/notes/no-h1.md", 2]] },
  { q: "compass", includeHistory: true, indexed: 19, matched: 2, ranked: [["wiki/notes/broken.md", 2.2], ["wiki/notes/no-h1.md", 2]] },
  { q: "code review checklist", includeHistory: false, indexed: 19, matched: 2, ranked: [["wiki/workflows/review.md", 11.7], ["wiki/projects/alpha.md", 4.6]] },
  { q: "code review checklist", includeHistory: true, indexed: 19, matched: 2, ranked: [["wiki/workflows/review.md", 11.7], ["wiki/projects/alpha.md", 4.6]] },
  { q: "how is it", includeHistory: false, indexed: 19, matched: 0, ranked: [] },
  { q: "how is it", includeHistory: true, indexed: 19, matched: 0, ranked: [] },
  { q: "zzqxv", includeHistory: false, indexed: 19, matched: 0, ranked: [] },
  { q: "zzqxv", includeHistory: true, indexed: 19, matched: 0, ranked: [] },
];

let root;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-corpus-'));
  const { pages } = JSON.parse(await fs.readFile(new URL('./recall-corpus.json', import.meta.url), 'utf8'));
  for (const [rel, text] of Object.entries(pages)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  }
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test('recall over the synthetic corpus reproduces wiki_recall.py: page set, order and scores', async () => {
  const pages = await loadWikiPages({ REPO_ROOT: root });
  for (const expected of REFERENCE) {
    const label = `${JSON.stringify(expected.q)} includeHistory=${expected.includeHistory}`;
    const hits = recall(expected.q, pages, { includeHistory: expected.includeHistory }).filter((r) => r.score > 0);
    assert.equal(pages.length, expected.indexed, `${label}: pages indexed`);
    assert.equal(hits.length, expected.matched, `${label}: pages sharing a word`);
    assert.deepEqual(hits.map((r) => r.page.path), expected.ranked.map(([p]) => p), `${label}: order`);
    hits.forEach((r, i) => {
      assert.ok(Math.abs(r.score - expected.ranked[i][1]) <= 0.05 + 1e-9, `${label}: score of ${r.page.path} = ${r.score}`);
    });
  }
});

test('the loader follows the reference page rules on the corpus', async () => {
  const pages = await loadWikiPages({ REPO_ROOT: root });
  const byPath = new Map(pages.map((p) => [p.path, p]));
  for (const skipped of ['wiki/index.md', 'wiki/log.md', 'wiki/_template.md', 'wiki/notes/nofm.md']) {
    assert.ok(!byPath.has(skipped), skipped);
  }
  assert.deepEqual(byPath.get('wiki/notes/broken.md').tags, []); // invalid YAML → indexed, no tags
  assert.equal(byPath.get('wiki/notes/broken.md').title, 'Broken Frontmatter');
  assert.equal(byPath.get('wiki/notes/no-h1.md').title, 'no-h1');
  assert.deepEqual(byPath.get('wiki/notes/scalar-tags.md').tags, []); // scalar is not a list
  assert.deepEqual(byPath.get('wiki/workflows/maintenance-pass.md').tags, ['maintenance', 'wiki-lint', 'cadence']);
  assert.deepEqual(byPath.get('wiki/projects/dup.md').tags, ['dup-tag', 'Dup-Tag', 'DUP-TAG']); // not deduped
  assert.equal(
    byPath.get('wiki/workflows/maintenance-pass.md').summary,
    'How the periodic maintenance pass works: run wiki lint, reconcile the index, and append a log entry.'
  );
  const { body: crlf, ...crlfRest } = byPath.get('wiki/notes/crlf.md');
  const { body: lf, ...lfRest } = byPath.get('wiki/notes/lf.md');
  assert.equal(crlf, lf);
  assert.deepEqual({ ...crlfRest, path: '' }, { ...lfRest, path: '' });
});

// ---- tags read as written (aos_wiki/frontmatter.tags) ------------------------
//
// Tags and rankings below were produced by the real reference on this synthetic tree,
// written to a temp dir outside the repo (memory repo 1905a94, Python 3.14.4, PyYAML
// 6.0.3): python3 ~/projects/agentic-os/scripts/wiki_recall.py --root <tmp> --top 100000 "<q>".
// PyYAML nodes keep every scalar as written; js-yaml's default schema would turn
// 4.10 into 4.1, 2026-01-01 into a Date and null/~ into null.
const YAML_EDGE = {
  'wiki/index.md': '---\ntags: []\n---\n# Index\n',
  'wiki/notes/numbers.md': '---\ntags: [4.10, 1.0, 2026-01-01]\n---\n# Numbers\n\n> Version-like and date-like tags.\n\nPlain body.\n',
  'wiki/notes/literals.md': '---\ntags: [true, True, null, ~, 0x1F, 007]\n---\n# Literals\n\n> Boolean- and null-like tags.\n\nPlain body.\n',
  'wiki/notes/duplicate.md': '---\ntags: [first]\nupdated: 2026-01-02\ntags: [last, 4.10]\n---\n# Duplicate\n\n> A repeated tags key.\n\nPlain body.\n',
  'wiki/notes/short.md': '---\ntags: [4.1]\n---\n# Short\n\n> A 4.1 tag only.\n\nPlain body.\n',
};
const YAML_EDGE_TAGS = {
  'wiki/notes/duplicate.md': ['last', '4.10'],
  'wiki/notes/literals.md': ['true', 'True', 'null', '~', '0x1F', '007'],
  'wiki/notes/numbers.md': ['4.10', '1.0', '2026-01-01'],
  'wiki/notes/short.md': ['4.1'],
};
const YAML_EDGE_RANKED = [
  { q: '4.10', ranked: [['wiki/notes/duplicate.md', 1], ['wiki/notes/numbers.md', 0.9]] },
  { q: '1.0', ranked: [['wiki/notes/numbers.md', 1.5]] },
  { q: '2026-01-01', ranked: [['wiki/notes/numbers.md', 3.4]] },
  { q: 'true null', ranked: [['wiki/notes/literals.md', 3.9]] },
  { q: 'first last', ranked: [['wiki/notes/duplicate.md', 1.8]] },
  { q: '4.1', ranked: [['wiki/notes/short.md', 2.2]] },
];

test('tags are read as written — versions, dates, booleans, null — and a repeated tags key takes the last', async () => {
  const edgeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-yaml-'));
  try {
    for (const [rel, text] of Object.entries(YAML_EDGE)) {
      await fs.mkdir(path.dirname(path.join(edgeRoot, rel)), { recursive: true });
      await fs.writeFile(path.join(edgeRoot, rel), text);
    }
    const pages = await loadWikiPages({ REPO_ROOT: edgeRoot });
    assert.deepEqual(Object.fromEntries(pages.map((p) => [p.path, p.tags])), YAML_EDGE_TAGS);
    for (const { q, ranked } of YAML_EDGE_RANKED) {
      const hits = recall(q, pages).filter((r) => r.score > 0);
      assert.deepEqual(hits.map((r) => r.page.path), ranked.map(([p]) => p), q);
      hits.forEach((r, i) => assert.ok(Math.abs(r.score - ranked[i][1]) <= 0.05 + 1e-9, `${q}: ${r.page.path} = ${r.score}`));
    }
  } finally {
    await fs.rm(edgeRoot, { recursive: true, force: true });
  }
});
