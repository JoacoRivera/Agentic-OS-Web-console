import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { REVIEW_BY_ITEM_LIMIT, collectReviewBy, scanReviewBy } from '../src/reviewBy.js';

// Mirrors wiki-lint check 25. All dates are synthetic; "today" is pinned.
const TODAY = '2026-11-14';
const NOW = new Date('2026-11-14T12:00:00');

test('scanReviewBy: due on the day itself and in the past, pending in the future', () => {
  const text = [
    'A lesson. review-by: 2026-11-14',
    'Older one review-by: 2026-01-31',
    'Later review-by: 2027-05-07',
  ].join('\n');
  assert.deepEqual(scanReviewBy(text, TODAY), [
    { line: 1, date: '2026-11-14', state: 'due' },
    { line: 2, date: '2026-01-31', state: 'due' },
    { line: 3, date: '2027-05-07', state: 'pending' },
  ]);
});

test('scanReviewBy: inline-code and plain forms, trailing punctuation stripped', () => {
  const text = 'Confirm (`review-by: 2027-05-07`).\nPlain review-by:2026-02-01). and review-by: 2026-03-01;';
  assert.deepEqual(scanReviewBy(text, TODAY), [
    { line: 1, date: '2027-05-07', state: 'pending' },
    { line: 2, date: '2026-02-01', state: 'due' },
    { line: 2, date: '2026-03-01', state: 'due' },
  ]);
});

test('scanReviewBy: a bare review-by: is a prose mention and is ignored', () => {
  assert.deepEqual(scanReviewBy('Give the lesson a `review-by:` date.\nreview-by:\n', TODAY), []);
  assert.deepEqual(scanReviewBy('review-by: .', TODAY), []);
});

test('scanReviewBy: impossible or non-date tokens are malformed', () => {
  assert.deepEqual(scanReviewBy('review-by: 2027-02-30\nreview-by: soon\nreview-by: 2027-5-7', TODAY), [
    { line: 1, date: '2027-02-30', state: 'malformed' },
    { line: 2, date: 'soon', state: 'malformed' },
    { line: 3, date: '2027-5-7', state: 'malformed' },
  ]);
});

test('scanReviewBy: line numbers follow CRLF and Python splitlines boundaries', () => {
  assert.deepEqual(scanReviewBy('one\r\ntwo\r\nreview-by: 2026-01-01\r\n', TODAY), [
    { line: 3, date: '2026-01-01', state: 'due' },
  ]);
});

let root;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-by-fixture-'));
  const write = async (rel, text) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  };
  await write(
    'wiki/lessons.md',
    '# Lessons\n\n- One `review-by: 2026-01-31`\n- Two review-by: 2099-01-01\n- Three review-by: soon\n- A `review-by:` date is the convention.\n- Four review-by: 2098-06-01\n'
  );
  await write('wiki/workflows/sample.md', '# Sample\n\nreview-by: 2026-10-01\n');
  // The log is history: a dated mention there is never due.
  await write('wiki/log.md', '## [2026-10-01] lint | x\nreview-by: 2026-01-01\n');
  await write('wiki/log/2026-10.md', '## [2026-10-01] lint | x\nreview-by: 2026-01-01\n');
  // Many due tokens on one page to exercise the cap.
  await write(
    'wiki/many.md',
    Array.from({ length: 25 }, (_, i) => `review-by: 2026-0${1 + (i % 9)}-1${i % 10}`).join('\n')
  );
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test('collectReviewBy: skips log files and keeps exact counters under the cap', async () => {
  const paths = ['wiki/lessons.md', 'wiki/workflows/sample.md', 'wiki/log.md', 'wiki/log/2026-10.md', 'wiki/many.md'];
  const out = await collectReviewBy(root, paths, NOW);
  assert.equal(out.dueN, 1 + 1 + 25);
  assert.equal(out.malformedN, 1);
  assert.equal(out.pendingN, 2);
  assert.equal(out.nextDue, '2098-06-01');
  assert.equal(out.items.length, REVIEW_BY_ITEM_LIMIT);
  assert.ok(out.items.every((item) => !item.path.startsWith('wiki/log')));
  assert.ok(out.items.every((item) => item.state === 'due'), 'due entries sort before malformed');
  const sorted = [...out.items].sort((a, b) => a.date.localeCompare(b.date));
  assert.deepEqual(out.items.map((i) => i.date), sorted.map((i) => i.date));
});

test('collectReviewBy: items carry {path, line, date, state} only — no page text', async () => {
  const out = await collectReviewBy(root, ['wiki/lessons.md'], NOW);
  assert.deepEqual(out, {
    dueN: 1,
    malformedN: 1,
    pendingN: 2,
    nextDue: '2098-06-01',
    items: [
      { path: 'wiki/lessons.md', line: 3, date: '2026-01-31', state: 'due' },
      { path: 'wiki/lessons.md', line: 5, date: 'soon', state: 'malformed' },
    ],
  });
});

test('collectReviewBy: nothing found → zero counters, nextDue null', async () => {
  assert.deepEqual(await collectReviewBy(root, [], NOW), {
    dueN: 0,
    malformedN: 0,
    pendingN: 0,
    nextDue: null,
    items: [],
  });
});
