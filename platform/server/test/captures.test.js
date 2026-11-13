import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computeMetrics } from '../src/metrics.js';
import { createConfig } from '../src/config.js';
import { declaredSourcePaths, isLogFile, isTemplatePath } from '../src/captures.js';

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
