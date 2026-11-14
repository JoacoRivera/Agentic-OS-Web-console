import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureIntakeDay, computeFlow, summarize } from '../src/flow.js';
import { computeMetrics } from '../src/metrics.js';
import { createConfig } from '../src/config.js';

/**
 * Memory-flow stats, mirrored from the memory repo's scripts/memory-stats.py
 * (ADR-0003 amendment 2026-11-14). Every capture and UUID here is synthetic.
 */

const UUID = '0f3c2a1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const TODAY = '2026-11-14';
const NEL = String.fromCharCode(0x85);
const FS = String.fromCharCode(0x1c);
const BOM = String.fromCharCode(0xfeff);
const fm = (lines) => `---\n${lines.join('\n')}\n---\n# capture\n\nStatus: Draft\n`;

test('captureIntakeDay mirrors memory-stats.py intake_date()', () => {
  // [label, text, expected]. One table: the rule lives in one function.
  const rows = [
    ['valid lowercase UUID + date', fm([`source_id: ${UUID}`, 'knowledge_intake_date: 2026-11-01']), '2026-11-01'],
    ['date double-quoted', fm([`source_id: ${UUID}`, 'knowledge_intake_date: "2026-11-01"']), '2026-11-01'],
    ['date single-quoted', fm([`source_id: ${UUID}`, "knowledge_intake_date: '2026-11-01'"]), '2026-11-01'],
    ['UUID in uppercase', fm([`source_id: ${UUID.toUpperCase()}`, 'knowledge_intake_date: 2026-11-01']), null],
    ['UUID quoted, lowercase', fm([`source_id: "${UUID}"`, 'knowledge_intake_date: 2026-11-01']), '2026-11-01'],
    ['only source_id', fm([`source_id: ${UUID}`]), null],
    ['only the date', fm(['knowledge_intake_date: 2026-11-01']), null],
    ['no frontmatter', `# capture\nsource_id: ${UUID}\nknowledge_intake_date: 2026-11-01\n`, null],
    ['frontmatter not at byte 0', `\n${fm([`source_id: ${UUID}`, 'knowledge_intake_date: 2026-11-01'])}`, null],
    ['impossible day', fm([`source_id: ${UUID}`, 'knowledge_intake_date: 2026-02-30']), null],
    ['timestamp', fm([`source_id: ${UUID}`, 'knowledge_intake_date: 2026-11-01T10:00:00Z']), null],
    ['slashes', fm([`source_id: ${UUID}`, 'knowledge_intake_date: 2026/11/01']), null],
    ['date after today', fm([`source_id: ${UUID}`, 'knowledge_intake_date: 2026-11-15']), null],
    ['date equal to today', fm([`source_id: ${UUID}`, `knowledge_intake_date: ${TODAY}`]), TODAY],
    ['trailing comment (first \\S+ token)', fm([`source_id: ${UUID}`, 'knowledge_intake_date: 2026-11-01 # note']), '2026-11-01'],
    ['value on the next line (\\s* crosses newlines)', fm([`source_id: ${UUID}`, 'knowledge_intake_date:', '  2026-11-01']), '2026-11-01'],
    ['indented key is not a top-of-line key', fm([`source_id: ${UUID}`, 'meta:', '  knowledge_intake_date: 2026-11-01']), null],
    ['no conflict/promotion rule: promoted_from is ignored', fm([`source_id: ${UUID}`, 'knowledge_intake_date: 2026-11-01', 'promoted_from: raw/x.md']), '2026-11-01'],
    ['invalid YAML elsewhere does not matter', fm([`source_id: ${UUID}`, 'knowledge_intake_date: 2026-11-01', 'tags: [unclosed']), '2026-11-01'],
    ['empty text', '', null],
    // Python's `\s` is str.isspace(): \x85 and \x1c are spaces, U+FEFF is not.
    ['NEL between key and colon', fm([`source_id${NEL}: ${UUID}`, 'knowledge_intake_date: 2026-10-04']), '2026-10-04'],
    ['\\x1c between colon and value', fm([`source_id: ${UUID}`, `knowledge_intake_date:${FS}2026-10-04`]), '2026-10-04'],
    ['trailing BOM is part of the token', fm([`source_id: ${UUID}${BOM}`, 'knowledge_intake_date: 2026-10-04']), null],
    // date.fromisoformat: years 0001-9999.
    ['year 0099', fm([`source_id: ${UUID}`, 'knowledge_intake_date: 0099-03-04']), '0099-03-04'],
    ['year 0000', fm([`source_id: ${UUID}`, 'knowledge_intake_date: 0000-03-04']), null],
    ['2100 is not a leap year', fm([`source_id: ${UUID}`, 'knowledge_intake_date: 2100-02-29']), null],
  ];
  for (const [label, text, expected] of rows) {
    assert.equal(captureIntakeDay(text, TODAY), expected, label);
  }
});

test('summarize follows memory-stats.py: null figures when empty, statistics.median, nearest-rank p90', () => {
  assert.deepEqual(summarize([]), { n: 0, min: null, median: null, p90: null, max: null });
  assert.deepEqual(summarize([4]), { n: 1, min: 4, median: 4, p90: 4, max: 4 });
  assert.deepEqual(summarize([3, 1, 2, 10]), { n: 4, min: 1, median: 2.5, p90: 10, max: 10 });
  const range = (n) => Array.from({ length: n }, (_, i) => i + 1);
  // k = max(1, ceil(n·90/100)) → 1, 9, 9, 10, 18
  assert.equal(summarize(range(1)).p90, 1);
  assert.equal(summarize(range(9)).p90, 9);
  assert.equal(summarize(range(10)).p90, 9);
  assert.equal(summarize(range(11)).p90, 10);
  assert.equal(summarize(range(20)).p90, 18);
});

// ---------- computeFlow on hand-built inputs ----------

let nextIndex = 0;
const entry = (dateText, op, subject, lines = []) => ({
  index: nextIndex++,
  file: 'wiki/log.md',
  dateText,
  op,
  subject,
  lines: [`## [${dateText}] ${op} | ${subject}`, ...lines],
});
const lineaged = (day, i = 0) => fm([`source_id: ${UUID.slice(0, -1)}${i}`, `knowledge_intake_date: ${day}`]);

function flowFor({ ingested = [], onHold = [], draft = [], entries = [], today = TODAY }) {
  const texts = new Map();
  const items = (list) => list.map(([p, text]) => {
    texts.set(p, text);
    return { path: p };
  });
  return computeFlow({
    buckets: { ingested: items(ingested), onHold: items(onHold), draft: items(draft) },
    texts,
    entries,
    today,
  });
}

test('latency: earliest dated ingest entry, invalid dates ignored, undated and negative split out', () => {
  // Newest first, as readLogEntries returns them.
  const entries = [
    entry('2026-03-12', 'ingest', 'file c', ['- `raw/p/examples/c.md`']),
    entry('2026-03-10', 'ingest', 'again', ['- `raw/p/examples/a.md`, `raw/p/examples/b.md`']),
    entry('2026-02-30', 'ingest', 'invalid date', ['- `raw/p/examples/b.md`']),
    entry('2026-02-20', 'ingest', 'first a', ['- `raw/p/examples/a.md`']),
    entry('2026-03-01', 'query', 'mentions', ['- `raw/p/examples/d.md`']), // not an ingest entry
  ];
  const f = flowFor({
    ingested: [
      ['raw/p/examples/a.md', lineaged('2026-02-20', 1)], // 0 days (earliest of two entries)
      ['raw/p/examples/b.md', lineaged('2026-03-01', 2)], // 9 days (02-30 ignored)
      ['raw/p/examples/c.md', lineaged('2026-03-15', 3)], // ingest before intake
      ['raw/p/examples/d.md', lineaged('2026-03-02', 4)], // no dated ingest entry
      ['raw/p/examples/e.md', '# no lineage\nStatus: Ingested\n'], // unlineaged
    ],
    draft: [['raw/p/examples/f.md', lineaged('2026-01-01', 5)]], // Draft never in latency
    entries,
  });
  assert.equal(f.latency.n, 2);
  assert.equal(f.latency.min, 0);
  assert.equal(f.latency.max, 9);
  assert.equal(f.latency.median, 4.5);
  assert.equal(f.latency.noDatedIngestEntry, 1);
  assert.equal(f.latency.ingestBeforeIntake, 1);
  assert.deepEqual(f.latency.buckets.map((b) => b.count), [1, 0, 0, 1, 0]);
  assert.deepEqual(f.captures, { total: 6, unlineaged: 1 });
});

test('latency bucket edges 0, 1, 3, 4, 7, 8, 30, 31', () => {
  const dayAfter = (n) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);
  const lags = [0, 1, 3, 4, 7, 8, 30, 31];
  const ingested = lags.map((n, i) => [`raw/p/examples/l${n}.md`, lineaged('2026-01-01', i)]);
  const entries = lags.map((n) => entry(dayAfter(n), 'ingest', `l${n}`, [`- raw/p/examples/l${n}.md`]));
  const f = flowFor({ ingested, entries });
  assert.deepEqual(
    f.latency.buckets,
    [
      { label: 'same day', count: 1 },
      { label: '1-3d', count: 2 },
      { label: '4-7d', count: 2 },
      { label: '8-30d', count: 2 },
      { label: '>30d', count: 1 },
    ]
  );
});

test('passes: one per day, gaps over the 7-day cadence, first longest gap, open gap', () => {
  const entries = [
    entry('2026-03-27', 'lint', 'maintenance pass'),
    entry('2026-03-20', 'lint', 'maintenance pass — clean'),
    entry('2026-03-15', 'lint', 'fix a broken link'), // a lint entry, not a pass
    entry('2026-03-12', 'lint', 'maintenance pass: second'),
    entry('2026-03-12', 'lint', 'maintenance pass'), // same day → one pass day
    entry('2026-02-30', 'lint', 'maintenance pass'), // invalid date → ignored
    entry('2026-03-04', 'lint', 'maintenance pass'),
  ];
  const f = flowFor({ entries, today: '2026-04-01' });
  assert.equal(f.passes.days, 4); // 03-04, 03-12, 03-20, 03-27
  assert.equal(f.passes.newest, '2026-03-27');
  assert.equal(f.passes.openGapDays, 5);
  assert.deepEqual(f.passes.gaps, { n: 3, min: 7, median: 8, p90: 8, max: 8 });
  assert.equal(f.passes.gapsOverCadence, 2); // 8 and 8; the 7-day gap is not over
  assert.equal(f.passes.cadenceDays, 7);
  assert.deepEqual(f.passes.longestGap, { from: '2026-03-04', to: '2026-03-12', days: 8 });
});

test('passes: none on record → absent figures, not zeros', () => {
  const f = flowFor({ entries: [entry('2026-03-15', 'lint', 'fix a broken link')] });
  assert.deepEqual(f.passes, {
    days: 0,
    newest: null,
    openGapDays: null,
    gaps: { n: 0, min: null, median: null, p90: null, max: null },
    gapsOverCadence: 0,
    cadenceDays: 7,
    longestGap: null,
  });
});

test('queue: counts, unlineaged, ages from intake to today', () => {
  const f = flowFor({
    draft: [
      ['raw/p/examples/d1.md', lineaged('2026-11-10', 1)],
      ['raw/p/examples/d2.md', lineaged('2026-11-01', 2)],
      ['raw/p/examples/d3.md', '# none\nStatus: Draft\n'],
    ],
    onHold: [['raw/p/examples/h1.md', '# none\nStatus: Draft\n']],
  });
  assert.deepEqual(f.queue.draft, {
    count: 3,
    unlineaged: 1,
    ages: { n: 2, min: 4, median: 8.5, p90: 13, max: 13 },
  });
  // Only unlineaged on hold: counted, but no age figure.
  assert.deepEqual(f.queue.onHold, {
    count: 1,
    unlineaged: 1,
    ages: { n: 0, min: null, median: null, p90: null, max: null },
  });
});

test('day arithmetic stays exact for years 0001-0099', () => {
  const f = flowFor({
    draft: [['raw/p/examples/old.md', lineaged('0099-02-24', 1)]],
    entries: [entry('0099-03-01', 'lint', 'maintenance pass'), entry('0099-02-20', 'lint', 'maintenance pass')],
    today: '0099-03-06',
  });
  assert.equal(f.queue.draft.ages.max, 10);
  assert.deepEqual(f.passes.longestGap, { from: '0099-02-20', to: '0099-03-01', days: 9 });
  assert.equal(f.passes.openGapDays, 5);
});

test('months: ascending, ingest-only months present, unlineaged in no month, other ops not counted', () => {
  const f = flowFor({
    ingested: [['raw/p/examples/a.md', lineaged('2026-09-03', 1)]],
    draft: [
      ['raw/p/examples/b.md', lineaged('2026-11-02', 2)],
      ['raw/p/examples/c.md', '# none\nStatus: Draft\n'],
    ],
    entries: [
      entry('2026-11-05', 'query', 'not counted'),
      entry('2026-10-04', 'ingest', 'file a', ['- `raw/p/examples/a.md`']),
      entry('2026-10-01', 'ingest', 'another'),
    ],
  });
  assert.deepEqual(f.months, [
    { month: '2026-09', captures: 1, ingestEntries: 0 },
    { month: '2026-10', captures: 0, ingestEntries: 2 },
    { month: '2026-11', captures: 1, ingestEntries: 0 },
  ]);
});

test('an empty tree yields a well-formed flow with absent figures', () => {
  const f = flowFor({});
  assert.deepEqual(f.captures, { total: 0, unlineaged: 0 });
  assert.deepEqual(f.months, []);
  assert.equal(f.latency.n, 0);
  assert.equal(f.latency.median, null);
  assert.equal(f.passes.newest, null);
});

test('flow carries no raw path or body text', () => {
  const f = flowFor({
    ingested: [['raw/p/examples/secret-name.md', lineaged('2026-11-01', 1) + 'body words\n']],
    draft: [['raw/p/examples/other.md', lineaged('2026-11-02', 2)]],
    entries: [entry('2026-11-03', 'ingest', 'file', ['- `raw/p/examples/secret-name.md`'])],
  });
  const json = JSON.stringify(f);
  assert.equal(json.includes('raw/'), false);
  assert.equal(json.includes('body words'), false);
});

// ---------- end to end through computeMetrics, on a synthetic temp repo ----------

let root;
let m;
const now = new Date('2026-11-14T12:00:00');

async function write(rel, content) {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aos-flow-fixture-'));
  await write('wiki/index.md', '# Index\n');
  await write(
    'wiki/log.md',
    [
      '# Activity Log',
      '',
      '## [2026-11-13] lint | maintenance pass — clean',
      '## [2026-11-12] ingest | file b',
      '- `raw/p/examples/b.md`',
      '## [2026-11-08] lint | maintenance pass',
      '',
    ].join('\n')
  );
  await write(
    'wiki/log/2026-10.md',
    ['# archive', '', '## [2026-10-30] ingest | file a', '- `raw/p/examples/a.md`', ''].join('\n')
  );
  await write('wiki/page.md', '---\nsource: [raw/p/examples/c.md]\n---\n# Page\n');
  const capture = (id, day, status) =>
    `---\nsource_id: ${id}\nknowledge_intake_date: ${day}\n---\n# capture\n\nStatus: ${status}\n`;
  await write('raw/p/examples/a.md', capture('11111111-2222-4333-8444-555555555551', '2026-10-30', 'Ingested'));
  await write('raw/p/examples/b.md', capture('11111111-2222-4333-8444-555555555552', '2026-11-09', 'Ingested'));
  await write('raw/p/examples/c.md', capture('11111111-2222-4333-8444-555555555553', '2026-11-01', 'Ingested'));
  await write('raw/p/examples/crlf.md', capture('11111111-2222-4333-8444-555555555554', '2026-11-04', 'Draft').replace(/\n/g, '\r\n'));
  await write('raw/p/examples/none.md', '# capture\n\nStatus: Draft\n');
  m = await computeMetrics(createConfig({ REPO_ROOT: root }), now);
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test('computeMetrics carries flow, consistent with the capture and health figures', () => {
  const f = m.flow;
  assert.equal(f.today, '2026-11-14');
  assert.equal(f.captures.total, m.capN);
  assert.deepEqual(f.captures, { total: 5, unlineaged: 1 });
  // a: 0 days, b: 3 days; c is cited only by a wiki source: list.
  assert.deepEqual(
    { n: f.latency.n, min: f.latency.min, max: f.latency.max, noDated: f.latency.noDatedIngestEntry },
    { n: 2, min: 0, max: 3, noDated: 1 }
  );
  assert.equal(f.passes.days, 2);
  assert.equal(f.passes.openGapDays, m.health.passAge);
  assert.deepEqual(f.passes.longestGap, { from: '2026-11-08', to: '2026-11-13', days: 5 });
  // The CRLF Draft reads exactly as LF: aged 10 days.
  assert.deepEqual(f.queue.draft, {
    count: 2,
    unlineaged: 1,
    ages: { n: 1, min: 10, median: 10, p90: 10, max: 10 },
  });
  assert.deepEqual(f.months, [
    { month: '2026-10', captures: 1, ingestEntries: 1 },
    { month: '2026-11', captures: 3, ingestEntries: 1 },
  ]);
});
