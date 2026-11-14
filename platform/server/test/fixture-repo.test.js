import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfig } from '../src/config.js';
import {
  classifyCaptures,
  isMaintenancePass,
  lastMaintenancePass,
  readHolds,
  readLogEntries,
} from '../src/captures.js';
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
 *   origin    'bridge' | 'other' on every capture row: 'bridge' when a header
 *             `Source:` line (before the first `## `) names the Memory Bridge
 *   legacy    `Status: Approved` (Ingested, legacy spelling)
 *   mismatch  the classifier's mismatch code
 *   sincePass first ingest log entry sits above the newest maintenance pass
 *   staleHold Ingested, yet still named in scripts/capture-holds.txt
 *   lineage   'origin' | 'promoted' | 'missing-lineage' | 'future-intake-date'
 *   intake    the file's `knowledge_intake_date` (origin rows; drives the
 *             Knowledge intake series)
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
  'raw/projects/examples/draft-plain.md': { capture: 'draft', origin: 'other', lineage: 'origin', intake: '2026-01-25' },
  'raw/projects/examples/draft-on-hold.md': { capture: 'on-hold', origin: 'other', lineage: 'origin', intake: '2025-12-20' },
  'raw/projects/examples/ingested-logged.md': { capture: 'ingested', origin: 'other', sincePass: true, lineage: 'origin', intake: '2026-01-16' },
  'raw/workflows/examples/ingested-legacy-approved.md': { capture: 'ingested', origin: 'other', legacy: true, lineage: 'origin', intake: '2025-11-20' },
  'raw/workflows/examples/ingested-status-mismatch.md': {
    capture: 'ingested',
    origin: 'other',
    mismatch: 'draft-with-evidence',
    lineage: 'origin', intake: '2025-12-15',
  },
  'raw/projects/draft-outside-examples.md': { capture: 'layout-warning', origin: 'other', lineage: 'origin', intake: '2026-01-05' },
  'raw/projects/examples/unlineaged.md': { capture: 'draft', origin: 'other', lineage: 'missing-lineage' },
  'raw/projects/examples/future-dated.md': { capture: 'draft', origin: 'other', lineage: 'future-intake-date', intake: '2999-01-01' },
  // Memory Bridge captures and decoys (i05). State does not depend on origin.
  'raw/projects/examples/bridge-draft.md': { capture: 'draft', origin: 'bridge', lineage: 'origin', intake: '2026-01-28' },
  'raw/projects/examples/bridge-draft-on-hold.md': { capture: 'on-hold', origin: 'bridge', lineage: 'origin', intake: '2025-11-28' },
  'raw/projects/examples/bridge-ingested-after-pass.md': { capture: 'ingested', origin: 'bridge', sincePass: true, lineage: 'origin', intake: '2026-01-19' },
  'raw/projects/examples/bridge-ingested-before-pass.md': { capture: 'ingested', origin: 'bridge', lineage: 'origin', intake: '2026-01-08' },
  'raw/projects/examples/ingested-before-pass.md': { capture: 'ingested', origin: 'other', lineage: 'origin', intake: '2026-01-06' },
  'raw/projects/examples/decoy-bridge-prose.md': { capture: 'draft', origin: 'other', lineage: 'origin', intake: '2025-12-28' },
  'raw/projects/examples/decoy-bridge-bullet.md': { capture: 'draft', origin: 'other', lineage: 'origin', intake: '2026-01-22' },
  // The bridge rule is header-only: the full marker line at column 0 after the
  // first `## ` heading (in a code fence, or under `## Notes`) is not bridge.
  'raw/projects/examples/decoy-bridge-fenced.md': { capture: 'draft', origin: 'other', lineage: 'origin', intake: '2026-01-26' },
  'raw/projects/examples/decoy-bridge-section.md': { capture: 'draft', origin: 'other', lineage: 'origin', intake: '2025-12-10' },
  // Classifier edge cases (review F3).
  'raw/projects/examples/ingested-without-evidence.md': {
    capture: 'ingested',
    origin: 'other',
    mismatch: 'marked-ingested-without-evidence',
    lineage: 'origin',
    intake: '2025-12-02',
  },
  'raw/projects/examples/ingested-stale-hold.md': {
    capture: 'ingested',
    origin: 'other',
    staleHold: true,
    lineage: 'origin',
    intake: '2025-11-15',
  },

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
const MISSING_HOLDS = 1; // scripts/capture-holds.txt lines naming no fixture file
const LAST_PASS = '2026-01-15'; // newest `lint | maintenance pass`; the 2026-01-18 lint must not reset it
// m.health at three clocks: fresh, due (stale) but not overdue, and overdue.
const HEALTH_AT = [
  { now: new Date(2026, 0, 20, 12), passAge: 5, healthStale: false, overdue: false, ageLabel: '5 DAYS AGO' },
  { now: new Date(2026, 0, 23, 12), passAge: 8, healthStale: true, overdue: false, ageLabel: '8 DAYS AGO' },
  { now: FIXED_NOW, passAge: 17, healthStale: true, overdue: true, ageLabel: '17 DAYS AGO' },
];
const SKILL_COUNT = 8;
const SYNTHETIC_SOURCE_ID = /^00000000-0000-4000-8000-0000000000\d{2}$/;

const rows = Object.entries(CASES).map(([p, row]) => ({ path: p, page: true, ...row }));
const pages = rows.filter((r) => r.page);
const where = (pred) => rows.filter(pred).map((r) => r.path).sort();
const count = (pred) => rows.filter(pred).length;
const config = createConfig({ REPO_ROOT: FIXTURE });
const holdWarnings = () => MISSING_HOLDS + count((r) => r.staleHold);

/** Local calendar day `offset` days from `date`, as YYYY-MM-DD. */
function localDay(date, offset = 0) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

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
  assert.deepEqual(where((r) => r.capture && !['bridge', 'other'].includes(r.origin)), [], 'capture row without an origin');
  // The > 0 counts are the tripwire for the memory repo rewording the marker.
  for (const state of ['draft', 'on-hold', 'ingested']) {
    assert.ok(count((r) => r.capture === state && r.origin === 'bridge') > 0, `no bridge ${state} capture`);
  }
  assert.ok(count((r) => r.sincePass && r.origin === 'bridge') > 0, 'no bridge capture ingested since the pass');
  assert.ok(count((r) => r.sincePass && r.origin === 'other') > 0, 'no other capture ingested since the pass');
  assert.ok(count((r) => r.legacy) > 0, 'no legacy Approved capture');
  for (const code of ['draft-with-evidence', 'marked-ingested-without-evidence']) {
    assert.ok(count((r) => r.mismatch === code) > 0, `no ${code} capture`);
  }
  assert.ok(count((r) => r.staleHold) > 0, 'no stale hold (hold naming an Ingested capture)');
  assert.ok(count((r) => r.sincePass) > 0, 'no capture ingested since the pass');
  assert.ok(
    count((r) => r.capture === 'ingested' && !r.sincePass) > 0,
    'no capture ingested before the pass'
  );
  const { holds } = await readHolds(FIXTURE);
  const missing = [...holds.keys()].filter((p) => !(p in CASES));
  assert.equal(missing.length, MISSING_HOLDS, 'holds lines naming no fixture file');
  assert.ok(MISSING_HOLDS > 0, 'no hold naming a missing capture');
  assert.deepEqual(
    [...holds.keys()].filter((p) => CASES[p]?.capture === 'ingested').sort(),
    where((r) => r.staleHold),
    'staleHold rows must match the holds lines naming Ingested captures'
  );
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
  const window = [localDay(FIXED_NOW, -29), localDay(FIXED_NOW)];
  assert.ok(count((r) => r.lineage === 'origin' && r.intake >= window[0]) > 0, 'no intake inside the 30-day window');
  assert.ok(count((r) => r.lineage === 'origin' && r.intake < window[0]) > 0, 'no intake before the 30-day window');
});

test('fixture: the log keeps the entries the cadence rules rely on', async () => {
  const entries = await readLogEntries(FIXTURE);
  const pass = lastMaintenancePass(entries);
  assert.ok(pass, 'no maintenance pass');
  assert.equal(pass.dateText, LAST_PASS);
  const above = entries.filter((e) => e.index < pass.index);
  const below = entries.filter((e) => e.index > pass.index);
  assert.ok(
    above.some((e) => e.op === 'lint' && !isMaintenancePass(e)),
    'no non-pass lint entry above the last pass (it must not reset the cadence)'
  );
  assert.ok(above.some((e) => e.op === 'ingest'), 'no ingest entry after the last pass');
  assert.ok(below.some((e) => e.op === 'ingest'), 'no ingest entry before the last pass');
  assert.ok(
    entries.some((e) => isMaintenancePass(e) && /^wiki\/log\/\d{4}-\d{2}\.md$/.test(e.file)),
    'no maintenance pass in a wiki/log/YYYY-MM.md archive (the pass gap)'
  );
  assert.ok(
    entries.some((e) => e.op === 'ingest' && e.file.startsWith('wiki/log/')),
    'no ingest entry in the archive'
  );
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
  assert.equal(buckets.holdWarning.length, holdWarnings());
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
    holdWarningN: holdWarnings(),
    bridge: {
      draftN: count((r) => r.capture === 'draft' && r.origin === 'bridge'),
      heldN: count((r) => r.capture === 'on-hold' && r.origin === 'bridge'),
      ingestedN: count((r) => r.capture === 'ingested' && r.origin === 'bridge'),
    },
  });
  for (const [key, n] of Object.entries(m.captures.bridge)) assert.ok(n > 0, `captures.bridge.${key} is 0`);
  // drafts[] is capped (DRAFT_LIMIT), so each listed row is checked against its own row.
  const listed = [...m.drafts, ...m.held];
  assert.deepEqual(listed.map((i) => [i.path, i.origin]), listed.map((i) => [i.path, CASES[i.path]?.origin]));
  assert.ok(listed.some((i) => i.origin === 'bridge'), 'no bridge row listed in drafts[] / held[]');

  assert.equal(m.health.lastPass, LAST_PASS);
  assert.equal(m.health.ingestedSincePass, count((r) => r.sincePass));
  assert.deepEqual(m.health.sincePass.byOrigin, {
    bridge: count((r) => r.sincePass && r.origin === 'bridge'),
    other: count((r) => r.sincePass && r.origin === 'other'),
  });
  assert.ok(m.health.sincePass.byOrigin.bridge > 0 && m.health.sincePass.byOrigin.other > 0);
  assert.deepEqual(
    m.health.sincePass.items.map((i) => [i.path, i.origin]).sort(),
    rows.filter((r) => r.sincePass).map((r) => [r.path, r.origin]).sort()
  );
  assert.equal(m.health.sincePass.truncated, false);

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

  // Knowledge intake (ADR-0003): distinct source IDs with intake <= day. The
  // promoted page inherits a source and must not add a point.
  const intakes = rows.filter((r) => r.lineage === 'origin').map((r) => r.intake);
  const series = [];
  for (let i = -29; i <= 0; i++) {
    const d = localDay(FIXED_NOW, i);
    series.push({ d, v: intakes.filter((day) => day <= d).length });
  }
  assert.deepEqual(m.series, series);
  assert.equal(m.last30, intakes.filter((day) => day >= localDay(FIXED_NOW, -29)).length);
});

test('fixture: maintenance-pass health at fresh, due and overdue clocks', async () => {
  for (const { now, ...want } of HEALTH_AT) {
    const { health } = await computeMetrics(config, now);
    assert.deepEqual(
      {
        lastPass: health.lastPass,
        passAge: health.passAge,
        healthStale: health.healthStale,
        overdue: health.overdue,
        ageLabel: health.ageLabel,
      },
      { lastPass: LAST_PASS, ...want },
      localDay(now)
    );
  }
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
