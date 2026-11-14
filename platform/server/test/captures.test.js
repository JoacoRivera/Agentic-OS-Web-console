import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computeMetrics } from '../src/metrics.js';
import { createConfig } from '../src/config.js';
import { captureOrigin, declaredSourcePaths, isLogFile, isTemplatePath } from '../src/captures.js';

/**
 * Capture lifecycle + maintenance-pass rules, mirrored from the memory repo's
 * scripts/aos_wiki/inventory.py and scripts/wiki_log.py (ADR-0002). Every
 * capture here is synthetic. The same tree is meant to read identically to
 * `python3 scripts/capture-inventory.py --root <fixture> --format json`.
 */

let root;
let m;
const now = new Date('2026-11-13T12:00:00');

async function write(rel, content) {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

const cap = (status) => `# capture\n\n${status}\n`;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aos-captures-fixture-'));
  await write('wiki/index.md', '# Index\n');
  await write(
    'wiki/log.md',
    [
      '# Activity Log',
      '',
      '## [2026-11-12] ingest | file the evidenced capture',
      '- filed `raw/p/examples/by-log.md` and raw/p/examples/by-log-2.md.',
      '- not evidence: raw/p/examples/fake.md.bak, xraw/p/examples/fake.md',
      '## [2026-11-11] lint | maintenance passes are now weekly', // not the subject form
      '## [2026-11-10] lint | fix a broken link', // a lint entry, not a pass
      '## [2026-11-09] query | mentions raw/p/examples/by-query.md', // not an ingest entry
      '',
    ].join('\n')
  );
  // The only real pass lives in the archive; the ingest above it counts as "since".
  await write(
    'wiki/log/2026-11.md',
    [
      '# Activity Log — 2026-11 (archive)',
      '',
      '## [2026-11-02] lint | maintenance pass — 2 fixes',
      '- lint clean.',
      '## [2026-11-01] ingest | older filing',
      '- `raw/p/examples/by-log-2.md`',
      '',
    ].join('\n')
  );
  await write(
    'wiki/page.md',
    '---\ntags: [x]\nsource:\n  - raw/p/examples/by-source.md # cited\n  - wiki/other.md\nupdated: 2026-11-12\n---\n# Page\n'
  );
  await write('wiki/dup.md', '---\nsource: raw/p/examples/dup-source.md\nsource: raw/p/examples/dup-source.md\n---\n');

  await write('raw/p/examples/draft.md', cap('Status: Draft'));
  await write('raw/p/examples/crlf-draft.md', '# capture\r\n\r\nStatus: Draft\r\n');
  await write('raw/p/examples/ingested.md', cap('Status: Ingested'));
  await write('raw/p/examples/legacy.md', cap('Status: Approved'));
  await write('raw/p/examples/two-markers.md', cap('Status: Draft\nStatus: Ingested'));
  await write('raw/p/examples/by-log.md', cap('Status: Draft')); // evidenced → Ingested (mismatch)
  await write('raw/p/examples/by-log-2.md', cap('Status: Ingested'));
  await write('raw/p/examples/by-source.md', cap('Status: Draft')); // evidenced → Ingested (mismatch)
  await write('raw/p/examples/by-query.md', cap('Status: Draft')); // query mention is not evidence
  await write('raw/p/examples/dup-source.md', cap('Status: Draft')); // unusable source: → not evidence
  await write('raw/p/examples/fake.md', cap('Status: Draft'));
  await write('raw/p/examples/held.md', cap('Status: Draft'));
  await write('raw/p/examples/held-but-ingested.md', cap('Status: Ingested'));
  await write('raw/p/unit/examples/README.md', cap('no marker')); // README is a capture inside examples/
  // out of scope
  await write('raw/p/examples/_template.md', cap('Status: Draft'));
  await write('raw/p/examples/capture-template.md', cap('Status: Draft'));
  await write('raw/templates/examples/t.md', cap('Status: Draft'));
  await write('raw/p/plan.md', '# plan\nPlan status: Draft\n');
  // outside examples/ with the unqualified marker
  await write('raw/p/notes-ingested.md', cap('Status: Ingested')); // in scope, Ingested
  await write('raw/p/notes-draft.md', cap('Status: Draft')); // layout warning

  await write(
    'scripts/capture-holds.txt',
    [
      '# hold list',
      'raw/p/examples/held.md  # waiting for the owner',
      'raw/p/examples/held-but-ingested.md # stale',
      'raw/p/examples/missing.md # matches nothing',
      'not a path',
      '',
    ].join('\n')
  );

  m = await computeMetrics(createConfig({ REPO_ROOT: root }), now);
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test('captures fall into Draft / on hold / Ingested exactly as the capture inventory does', () => {
  assert.equal(m.draftN, 7); // draft, crlf-draft, two-markers, by-query, dup-source, fake, README
  assert.equal(m.heldN, 1);
  assert.equal(m.ingestedN, 7); // ingested, legacy, by-log, by-log-2, by-source, held-but-ingested, notes-ingested
  assert.equal(m.capN, m.draftN + m.heldN + m.ingestedN);
  assert.deepEqual(
    m.held.map((h) => [h.path, h.reason]),
    [['raw/p/examples/held.md', 'waiting for the owner']]
  );
  assert.deepEqual(m.captures, {
    legacyApprovedN: 1,
    // by-log + by-source (Draft but cited); ingested, legacy, held-but-ingested,
    // notes-ingested (marked but no evidence); by-log-2 is marked AND cited.
    mismatchN: 6,
    layoutWarningN: 1, // notes-draft
    holdWarningN: 3, // malformed line, stale hold, hold matching nothing
    bridge: { draftN: 0, heldN: 0, ingestedN: 0 },
  });
});

test('Draft list paths never include templates or qualified markers', () => {
  const all = [...m.drafts, ...m.held].map((d) => d.path);
  for (const p of all) {
    assert.ok(!p.includes('template'), p);
    assert.notEqual(p, 'raw/p/plan.md');
  }
});

test('the maintenance pass is the newest `lint | maintenance pass` entry, archive included', () => {
  assert.equal(m.health.lastPass, '2026-11-02');
  assert.equal(m.health.passAge, 11);
  assert.equal(m.health.healthStale, true);
  assert.equal(m.health.overdue, true);
  assert.equal(m.health.ageLabel, '11 DAYS AGO');
  // Only by-log: its first ingest entry sits above the pass. by-log-2 was first
  // ingested below it; by-source has no ingest entry, so no ingest position.
  assert.equal(m.health.ingestedSincePass, 1);
});

test('the log archive is not a wiki page', () => {
  assert.equal(m.wikiN, 2); // page.md, dup.md — not index, log, or wiki/log/2026-11.md
  assert.equal(isLogFile('wiki/log.md'), true);
  assert.equal(isLogFile('wiki/log/2026-11.md'), true);
  assert.equal(isLogFile('wiki/log/sub/deeper.md'), false);
  assert.equal(isLogFile('wiki/logbook.md'), false);
});

test('template scope uses repo-relative parts only', () => {
  assert.equal(isTemplatePath('raw/p/examples/_template.md'), true);
  assert.equal(isTemplatePath('raw/p/examples/x-template.md'), true);
  assert.equal(isTemplatePath('raw/Templates/examples/x.md'), true);
  assert.equal(isTemplatePath('raw/p/examples/templates.md'), false);
});

test('source: reads scalar, flow and block forms; unusable declarations are null', () => {
  assert.deepEqual(declaredSourcePaths('source: raw/a.md'), ['raw/a.md']);
  assert.deepEqual(declaredSourcePaths('source: [raw/a.md, wiki/b.md]'), ['raw/a.md']);
  assert.deepEqual(declaredSourcePaths('source:\n  - raw/a.md # note\n'), ['raw/a.md']);
  assert.deepEqual(declaredSourcePaths('tags: [x]'), []);
  assert.equal(declaredSourcePaths('source: raw/a.md\nsource: raw/b.md'), null);
  assert.equal(declaredSourcePaths('source: [raw/a.md, 3]'), null);
  assert.equal(declaredSourcePaths('source: [unclosed'), null);
});

// ---------- capture origin: the Memory Bridge (memory repo ADR-0003) ----------

const BRIDGE_LINE =
  'Source: Agentic OS Memory Bridge automatic capture (client synthetic-client, role evaluator); capture-key 0123456789abcdef';
const OTHER_LINE = 'Source: Claude Code session (synthetic)';

test('captureOrigin: only a `Source:` line naming the bridge marks a bridge capture', () => {
  assert.equal(captureOrigin(`# c\n\n${BRIDGE_LINE}\nStatus: Draft\n`), 'bridge');
  assert.equal(captureOrigin(`# c\r\n\r\n${BRIDGE_LINE}\r\nStatus: Draft\r\n`), 'bridge');
  assert.equal(
    captureOrigin('# c\n\nWe discussed the Agentic OS Memory Bridge automatic capture flow.\n'),
    'other'
  );
  assert.equal(captureOrigin(`# c\n\n- ${BRIDGE_LINE}\n`), 'other');
  assert.equal(captureOrigin(`# c\n\nOriginal ${BRIDGE_LINE}\n`), 'other');
  assert.equal(captureOrigin(`# c\n\n${OTHER_LINE}\n`), 'other');
  assert.equal(captureOrigin('# c\n\nStatus: Draft\n'), 'other');
  assert.equal(captureOrigin(''), 'other');
});

/**
 * A second synthetic tree: bridge captures on both sides of a maintenance
 * pass, a bridge Draft, a held bridge Draft, and a decoy that only mentions
 * the bridge. `withSource: false` writes the same tree without any `Source:`
 * line, to prove origin never changes capture state.
 */
async function bridgeTree(withSource) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aos-bridge-fixture-'));
  const put = async (rel, content) => {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  };
  const src = (line) => (withSource ? `${line}\n` : '');
  const capture = (line, status, body = '') => `# capture\n\n${src(line)}${status}\n${body}`;
  await put(
    'wiki/log.md',
    [
      '# Activity Log',
      '',
      '## [2026-11-12] ingest | file another capture',
      '- `raw/p/examples/other-since.md`',
      '## [2026-11-11] ingest | file a bridge capture',
      '- `raw/p/examples/bridge-since.md`',
      '## [2026-11-09] lint | maintenance pass',
      '- lint clean.',
      '## [2026-11-05] ingest | older bridge filing',
      '- `raw/p/examples/bridge-old.md`',
      '',
    ].join('\n')
  );
  await put('raw/p/examples/bridge-draft.md', capture(BRIDGE_LINE, 'Status: Draft'));
  await put('raw/p/examples/bridge-held.md', capture(BRIDGE_LINE, 'Status: Draft'));
  await put('raw/p/examples/bridge-since.md', capture(BRIDGE_LINE, 'Status: Ingested'));
  await put('raw/p/examples/bridge-old.md', capture(BRIDGE_LINE, 'Status: Ingested'));
  await put('raw/p/examples/other-since.md', capture(OTHER_LINE, 'Status: Ingested'));
  await put(
    'raw/p/examples/decoy.md',
    capture(
      OTHER_LINE,
      'Status: Draft',
      `\n## Notes\n\nThe Agentic OS Memory Bridge automatic capture is discussed here.\n- ${BRIDGE_LINE}\n`
    )
  );
  await put('scripts/capture-holds.txt', 'raw/p/examples/bridge-held.md # parked\n');
  return dir;
}

let bridgeRoot;
let plainRoot;
let b;
let plain;

before(async () => {
  bridgeRoot = await bridgeTree(true);
  plainRoot = await bridgeTree(false);
  b = await computeMetrics(createConfig({ REPO_ROOT: bridgeRoot }), now);
  plain = await computeMetrics(createConfig({ REPO_ROOT: plainRoot }), now);
});

after(async () => {
  await fs.rm(bridgeRoot, { recursive: true, force: true });
  await fs.rm(plainRoot, { recursive: true, force: true });
});

test('bridge captures land in the same buckets as their non-bridge twins', () => {
  assert.deepEqual(b.captures.bridge, { draftN: 1, heldN: 1, ingestedN: 2 });
  assert.deepEqual([b.draftN, b.heldN, b.ingestedN], [2, 1, 3]);
  assert.deepEqual([b.draftN, b.heldN, b.ingestedN], [plain.draftN, plain.heldN, plain.ingestedN]);
  assert.deepEqual(plain.captures.bridge, { draftN: 0, heldN: 0, ingestedN: 0 });
  const origins = Object.fromEntries([...b.drafts, ...b.held].map((d) => [d.name, d.origin]));
  assert.deepEqual(origins, { 'bridge-draft': 'bridge', decoy: 'other', 'bridge-held': 'bridge' });
});

test('captures ingested since the last pass are listed by origin, bridge first', () => {
  assert.equal(b.health.ingestedSincePass, 2);
  assert.deepEqual(b.health.sincePass, {
    byOrigin: { bridge: 1, other: 1 },
    items: [
      { name: 'bridge-since', path: 'raw/p/examples/bridge-since.md', origin: 'bridge', ingestedOn: '2026-11-11' },
      { name: 'other-since', path: 'raw/p/examples/other-since.md', origin: 'other', ingestedOn: '2026-11-12' },
    ],
    truncated: false,
  });
  const { bridge, other } = b.health.sincePass.byOrigin;
  assert.equal(bridge + other, b.health.ingestedSincePass);
});

test('no maintenance pass on record → no since-pass list', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aos-bridge-nopass-'));
  try {
    await fs.mkdir(path.join(dir, 'raw/p/examples'), { recursive: true });
    await fs.writeFile(path.join(dir, 'raw/p/examples/a.md'), `# c\n\n${BRIDGE_LINE}\nStatus: Ingested\n`);
    const nopass = await computeMetrics(createConfig({ REPO_ROOT: dir }), now);
    assert.equal(nopass.health.ingestedSincePass, null);
    assert.equal(nopass.health.sincePass, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the since-pass list is capped; byOrigin keeps full counts and every bridge row', async () => {
  const capped = await computeMetrics(
    { ...createConfig({ REPO_ROOT: bridgeRoot }), SINCE_PASS_LIMIT: 1 },
    now
  );
  assert.equal(capped.health.sincePass.items.length, 1);
  assert.equal(capped.health.sincePass.truncated, true);
  assert.deepEqual(capped.health.sincePass.byOrigin, { bridge: 1, other: 1 });
  assert.deepEqual(
    capped.health.sincePass.items.map((i) => i.origin),
    ['bridge']
  );
});

test('no Source: line text leaks into /api/metrics (raw content stays gated)', () => {
  const json = JSON.stringify(b);
  for (const secret of ['synthetic-client', 'evaluator', '0123456789abcdef', 'automatic capture']) {
    assert.ok(!json.includes(secret), secret);
  }
});
