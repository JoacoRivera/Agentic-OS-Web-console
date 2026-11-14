import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfig } from '../src/config.js';
import { classifyCaptures, readLogEntries } from '../src/captures.js';
import { computeMetrics } from '../src/metrics.js';
import { listOperations } from '../src/operations.js';
import { listSkills } from '../src/skills.js';
import { listWorkflows, STATUS_LABELS, WORKFLOW_KINDS } from '../src/workflows.js';

/**
 * Guard for the committed synthetic memory repo that CI runs the live-repo
 * checks against (`npm run ci:fixture`). Those checks compare the console with
 * an independent recount, so they stay green when the fixture gets thinner;
 * this test is what goes red when a case disappears.
 *
 * Every `raw/**.md` and `wiki/**.md` in the fixture has exactly one row below.
 * Adding a case = add the file + one row (and the hand-derived constants if it
 * moves them); existing rows are not edited. The totals are tallied from the
 * table, never read back from the code under test.
 *
 * Row fields:
 *   page      false for files that are not metrics pages (README/index/log/
 *             _template basenames and the wiki/log/ archive)
 *   capture   'draft' | 'on-hold' | 'ingested' | 'layout-warning' (raw only;
 *             absent = not a capture)
 *   legacy    `Status: Approved` (Ingested, legacy spelling)
 *   mismatch  the classifier's mismatch code
 *   sincePass first ingest log entry sits above the newest maintenance pass
 *   lineage   'origin' | 'promoted' | 'missing-lineage' | 'future-intake-date'
 *   workflow  { kind, status } for wiki/workflows rows; status 'excluded' for
 *             examples/cases/results data
 */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'memory-repo');
// Local noon, so every pinned day holds in any CI timezone.
const FIXED_NOW = new Date(2026, 1, 1, 12, 0, 0);

const NOT_A_PAGE = { page: false };
const wf = (kind, status) => ({ lineage: 'missing-lineage', workflow: { kind, status } });

const CASES = {
  // ---- raw/ ----
  'raw/README.md': NOT_A_PAGE,
  'raw/projects/examples/draft-plain.md': { capture: 'draft', lineage: 'origin' },
  'raw/projects/examples/draft-on-hold.md': { capture: 'on-hold', lineage: 'origin' },
  'raw/projects/examples/ingested-logged.md': { capture: 'ingested', sincePass: true, lineage: 'origin' },
  'raw/workflows/examples/ingested-legacy-approved.md': { capture: 'ingested', legacy: true, lineage: 'origin' },
  'raw/workflows/examples/ingested-status-mismatch.md': {
    capture: 'ingested',
    mismatch: 'draft-with-evidence',
    lineage: 'origin',
  },
  'raw/projects/draft-outside-examples.md': { capture: 'layout-warning', lineage: 'origin' },
  'raw/projects/examples/unlineaged.md': { capture: 'draft', lineage: 'missing-lineage' },
  'raw/projects/examples/future-dated.md': { capture: 'draft', lineage: 'future-intake-date' },
  // Memory Bridge captures and decoys (i05). State does not depend on origin.
  'raw/projects/examples/bridge-draft.md': { capture: 'draft', lineage: 'origin' },
  'raw/projects/examples/bridge-draft-on-hold.md': { capture: 'on-hold', lineage: 'origin' },
  'raw/projects/examples/bridge-ingested-after-pass.md': { capture: 'ingested', sincePass: true, lineage: 'origin' },
  'raw/projects/examples/bridge-ingested-before-pass.md': { capture: 'ingested', lineage: 'origin' },
  'raw/projects/examples/ingested-before-pass.md': { capture: 'ingested', lineage: 'origin' },
  'raw/projects/examples/decoy-bridge-prose.md': { capture: 'draft', lineage: 'origin' },
  'raw/projects/examples/decoy-bridge-bullet.md': { capture: 'draft', lineage: 'origin' },

  // ---- wiki/ ----
  'wiki/index.md': NOT_A_PAGE,
  'wiki/log.md': NOT_A_PAGE,
  'wiki/log/2025-12.md': NOT_A_PAGE,
  'wiki/_template.md': NOT_A_PAGE,
  'wiki/agentic-os-usage.md': { lineage: 'missing-lineage' },
  'wiki/projects/sample-project.md': { lineage: 'promoted' },
  'wiki/workflows/runbook-ok.md': wf('runbook', 'ok'),
  'wiki/workflows/evals.md': wf('eval-suite', 'ok'),
  'wiki/workflows/reference-ok.md': wf('reference', 'ok'),
  'wiki/workflows/policy-ok.md': wf('policy', 'ok'),
  'wiki/workflows/inventory-ok.md': wf('inventory', 'ok'),
  'wiki/workflows/style-guide-ok.md': wf('style-guide', 'ok'),
  'wiki/workflows/unclassified.md': wf(null, 'unclassified'),
  'wiki/workflows/not-indexed.md': wf('reference', 'missing-links'),
  'wiki/workflows/runbook-todo.md': wf('runbook', 'needs-review'),
  'wiki/workflows/runbook-ok/examples/sample.md': wf(null, 'excluded'),
};

// Hand-derived from the fixture's non-file inputs.
const HOLD_WARNINGS = 1; // scripts/capture-holds.txt names one missing capture
const LAST_PASS = '2026-01-15'; // newest `lint | maintenance pass`; the 2026-01-18 lint must not reset it
const PASS_AGE = 17; // days from LAST_PASS to FIXED_NOW
const SKILL_COUNT = 8;
const SYNTHETIC_SOURCE_ID = /^00000000-0000-4000-8000-0000000000\d{2}$/;

const rows = Object.entries(CASES).map(([p, row]) => ({ path: p, page: true, ...row }));
const pages = rows.filter((r) => r.page);
const where = (pred) => rows.filter(pred).map((r) => r.path).sort();
const count = (pred) => rows.filter(pred).length;
const config = createConfig({ REPO_ROOT: FIXTURE });

async function walkMd(rel) {
  const out = [];
  for (const entry of await fs.readdir(path.join(FIXTURE, rel), { withFileTypes: true })) {
    const p = `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walkMd(p)));
    else if (entry.name.endsWith('.md')) out.push(p);
  }
  return out;
}

async function fixtureFiles(rel = '.') {
  const out = [];
  for (const entry of await fs.readdir(path.join(FIXTURE, rel), { withFileTypes: true })) {
    const p = rel === '.' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await fixtureFiles(p)));
    else out.push(p);
  }
  return out;
}

test('fixture: every raw/ and wiki/ file has exactly one case row, and every row a file', async () => {
  const onDisk = [...(await walkMd('raw')), ...(await walkMd('wiki'))].sort();
  const inTable = Object.keys(CASES).sort();
  assert.deepEqual(
    onDisk.filter((p) => !(p in CASES)),
    [],
    'fixture file without a case row — add one to CASES'
  );
  assert.deepEqual(
    inTable.filter((p) => !onDisk.includes(p)),
    [],
    'case row without a fixture file — the fixture lost a case'
  );
});

test('fixture: minimum coverage of every case the CI checks rely on', async () => {
  for (const state of ['draft', 'on-hold', 'ingested', 'layout-warning']) {
    assert.ok(count((r) => r.capture === state) > 0, `no ${state} capture`);
  }
  assert.ok(count((r) => r.legacy) > 0, 'no legacy Approved capture');
  assert.ok(count((r) => r.mismatch) > 0, 'no status-mismatch capture');
  assert.ok(count((r) => r.sincePass) > 0, 'no capture ingested since the pass');
  assert.ok(
    count((r) => r.capture === 'ingested' && !r.sincePass) > 0,
    'no capture ingested before the pass'
  );
  assert.ok(HOLD_WARNINGS > 0, 'no hold warning');
  for (const verdict of ['origin', 'promoted', 'missing-lineage', 'future-intake-date']) {
    assert.ok(count((r) => r.lineage === verdict) > 0, `no ${verdict} lineage case`);
  }
  for (const kind of Object.keys(WORKFLOW_KINDS)) {
    assert.ok(count((r) => r.workflow?.kind === kind) > 0, `no ${kind} workflow`);
  }
  // `stale` joins this list when staleness reads `updated:` (i06); with mtime
  // a fresh checkout cannot be stale.
  for (const status of ['ok', 'unclassified', 'missing-links', 'needs-review']) {
    assert.ok(status in STATUS_LABELS);
    assert.ok(count((r) => r.workflow?.status === status) > 0, `no ${status} workflow`);
  }
  assert.ok(count((r) => r.workflow?.status === 'excluded') > 0, 'no excluded examples/ data');
});

test('fixture: every source_id uses the reserved synthetic pattern, once', async () => {
  const ids = [];
  for (const rel of await fixtureFiles()) {
    if (!rel.endsWith('.md')) continue;
    const text = await fs.readFile(path.join(FIXTURE, rel), 'utf8');
    for (const [, id] of text.matchAll(/^source_id:[ \t]*(.*)$/gm)) {
      assert.match(id.trim(), SYNTHETIC_SOURCE_ID, `${rel}: non-synthetic source_id`);
      ids.push(id.trim());
    }
  }
  assert.equal(new Set(ids).size, ids.length, 'a source_id is reused');
  assert.equal(ids.length, count((r) => r.lineage === 'origin' || r.lineage === 'future-intake-date'));
});

test('fixture: each capture classifies exactly as its row says', async () => {
  const rawPaths = await walkMd('raw');
  const wikiPaths = await walkMd('wiki');
  const { buckets } = await classifyCaptures(FIXTURE, rawPaths, wikiPaths, await readLogEntries(FIXTURE));
  const paths = (items) => items.map((i) => i.path).sort();

  assert.deepEqual(paths(buckets.draft), where((r) => r.capture === 'draft'));
  assert.deepEqual(paths(buckets.onHold), where((r) => r.capture === 'on-hold'));
  assert.deepEqual(paths(buckets.ingested), where((r) => r.capture === 'ingested'));
  assert.deepEqual(paths(buckets.layoutWarning), where((r) => r.capture === 'layout-warning'));
  assert.deepEqual(
    paths(buckets.ingested.filter((i) => i.status === 'Approved')),
    where((r) => r.legacy)
  );
  assert.deepEqual(
    buckets.ingested.filter((i) => i.mismatch).map((i) => [i.path, i.mismatch]).sort(),
    rows.filter((r) => r.mismatch).map((r) => [r.path, r.mismatch]).sort()
  );
  assert.equal(buckets.holdWarning.length, HOLD_WARNINGS);
});

test('fixture: metrics at FIXED_NOW equal the totals tallied from the table', async () => {
  const m = await computeMetrics(config, FIXED_NOW);
  const draftN = count((r) => r.capture === 'draft');
  const heldN = count((r) => r.capture === 'on-hold');
  const ingestedN = count((r) => r.capture === 'ingested');

  assert.equal(m.wikiN, pages.filter((r) => r.path.startsWith('wiki/')).length);
  assert.equal(m.rawN, pages.filter((r) => r.path.startsWith('raw/')).length);
  assert.deepEqual(
    { capN: m.capN, draftN: m.draftN, heldN: m.heldN, ingestedN: m.ingestedN },
    { capN: draftN + heldN + ingestedN, draftN, heldN, ingestedN }
  );
  assert.deepEqual(m.captures, {
    legacyApprovedN: count((r) => r.legacy),
    mismatchN: count((r) => r.mismatch),
    layoutWarningN: count((r) => r.capture === 'layout-warning'),
    holdWarningN: HOLD_WARNINGS,
  });

  assert.equal(m.health.lastPass, LAST_PASS);
  assert.equal(m.health.passAge, PASS_AGE);
  assert.equal(m.health.ingestedSincePass, count((r) => r.sincePass));

  const problems = pages
    .filter((r) => r.lineage === 'missing-lineage' || r.lineage === 'future-intake-date')
    .map((r) => ({ path: r.path, reason: r.lineage }))
    .sort((a, b) => (a.reason !== b.reason ? (a.reason < b.reason ? -1 : 1) : a.path < b.path ? -1 : 1));
  assert.ok(problems.length <= 20, 'more problems than the capped sample; compare reasonCounts only');
  const { reasonCounts, problems: reported, ...counters } = m.lineage;
  assert.deepEqual(counters, {
    eligibleN: pages.length,
    lineagedN: count((r) => r.lineage === 'origin' || r.lineage === 'promoted'),
    unlineagedN: count((r) => r.lineage === 'missing-lineage'),
    invalidN: count((r) => r.lineage === 'future-intake-date'),
    promotedN: count((r) => r.lineage === 'promoted'),
    conflictingSourceIdsN: 0,
    futureDatedSourceIdsN: count((r) => r.lineage === 'future-intake-date'),
  });
  assert.deepEqual(reported, problems);
  assert.deepEqual(reasonCounts, {
    'future-intake-date': count((r) => r.lineage === 'future-intake-date'),
    'missing-lineage': count((r) => r.lineage === 'missing-lineage'),
  });
  assert.equal(m.knowledgeN, count((r) => r.lineage === 'origin'));
});

test('fixture: each workflow gets the status and kind its row says', async () => {
  const { workflows, summary } = await listWorkflows(config, FIXED_NOW);
  const expected = rows
    .filter((r) => r.workflow && r.workflow.status !== 'excluded')
    .map((r) => [r.path, r.workflow.kind, r.workflow.status])
    .sort();
  assert.deepEqual(workflows.map((w) => [w.path, w.kind, w.status]).sort(), expected);
  for (const status of Object.keys(STATUS_LABELS)) {
    assert.equal(summary[status], count((r) => r.workflow?.status === status), status);
  }
});

test('fixture: the skill stubs cover every Skill the Operations catalog references', async () => {
  const { skills } = await listSkills(config);
  const names = skills.map((s) => s.name).sort();
  const referenced = [...new Set(listOperations().operations.map((o) => o.skill).filter(Boolean))].sort();
  assert.equal(names.length, SKILL_COUNT);
  assert.deepEqual(names, referenced);
});
