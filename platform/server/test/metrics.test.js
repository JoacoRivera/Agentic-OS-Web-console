import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { computeMetrics, isApprovedText, target } from '../src/metrics.js';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date();
const daysAgo = (n) => new Date(now.getTime() - n * DAY_MS);
const isoDay = (date) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

let root;
let bare;
let strict;
let graph;
let problemCap;
let metrics;
let graphMetrics;

async function write(base, rel, content = `# ${rel}\n`) {
  const abs = path.join(base, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

function origin(sourceId, date, body = '') {
  return [
    '---',
    `source_id: ${sourceId}`,
    `knowledge_intake_date: ${isoDay(date)}`,
    '---',
    body,
  ].join('\n');
}

function promotedFrom(ref, body = '') {
  return ['---', `promoted_from: ${ref}`, '---', body].join('\n');
}

async function touch(rel, date) {
  await fs.utimes(path.join(root, rel), date, date);
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aos-metrics-fixture-'));

  // ---- batch 1, added 40 days ago (before the 30-day window) ----
  // Knowledge origins here: page-a + note-b = 2. The other files are
  // navigation/tooling/archive scaffolding, not intake events.
  await write(root, 'wiki/index.md'); // skipped in wikiN, counted in all
  await write(
    root,
    'wiki/log.md',
    [
      '# Activity Log',
      '',
      `## [${isoDay(daysAgo(1))}] ingest | something else`,
      `## [${isoDay(daysAgo(3))}] lint | most recent pass`, // first lint match wins
      `## [${isoDay(daysAgo(20))}] lint | an older pass`,
      '',
    ].join('\n')
  );
  await write(root, 'wiki/_template.md'); // excluded everywhere, even from all
  await write(root, 'wiki/page-a.md', origin('page-a', daysAgo(40), '# Page A\n'));
  await write(root, 'templates/tmpl.md');
  await write(root, 'templates/_template.md'); // excluded from all
  await write(root, 'dashboards/dash.md');
  await write(root, 'raw/README.md'); // skipped in rawN, counted in all
  await write(root, 'raw/note-b.md', origin('note-b', daysAgo(40), '# Note B\n'));
  await write(root, 'raw/assets/.gitkeep', ''); // not a page at all

  // ---- batch 2, added 10 days ago: raw side (8 all-members) ----
  await write(
    root,
    'raw/promoted-item.md',
    origin('promoted-item', daysAgo(10), '# Raw promoted item\n')
  );
  await write(root, 'raw/projects/proj-raw.md', origin('proj-raw', daysAgo(10), '# Raw project\n'));
  await write(root, 'raw/workflows/flow-raw.md', origin('flow-raw', daysAgo(10), '# Raw flow\n'));
  await write(
    root,
    'raw/projects/client/examples/cap-draft.md',
    origin('cap-draft', daysAgo(10), '# capture\nno status yet\n')
  );
  await write(
    root,
    'raw/projects/client/examples/cap-draft2.md',
    origin('cap-draft2', daysAgo(10), '# capture\nStatus: Draft\n')
  );
  await write(
    root,
    'raw/projects/client/examples/cap-inline.md',
    origin('cap-inline', daysAgo(10), '# capture\nStatus: Approved\n')
  );
  await write(
    root,
    'raw/projects/client/examples/cap-list.md',
    origin('cap-list', daysAgo(10), '# capture\nStatus:\n- Approved\n')
  );
  await write(
    root,
    'raw/projects/client/examples/cap-front.md',
    [
      '---',
      'source_id: cap-front',
      `knowledge_intake_date: ${isoDay(daysAgo(10))}`,
      'status: approved',
      '---',
      '# capture',
      '',
    ].join('\n')
  );

  // ---- batch 3, added 2 days ago: wiki side, incl. the promotion (5) ----
  // The promoted wiki path inherits the raw source's intake lineage and adds
  // no knowledge event. The other four pages are new direct origins.
  await write(
    root,
    'wiki/promoted-item.md',
    promotedFrom('raw/promoted-item.md', '# Published item\n')
  );
  await write(root, 'wiki/projects/proj-a.md', origin('proj-a', daysAgo(2), '# Project A\n'));
  await write(root, 'wiki/projects/nested/deep.md', origin('deep', daysAgo(2), '# Deep\n'));
  await write(root, 'wiki/workflows/flow-a.md', origin('flow-a', daysAgo(2), '# Flow A\n'));
  await write(
    root,
    'wiki/workflows/flow-a/examples/ex-1.md',
    origin('ex-1', daysAgo(2), '# Example\n')
  );

  // ---- mtimes: everything quiet 20 days ago, three edits this week ----
  for (const rel of [
    'wiki/index.md', 'wiki/log.md', 'wiki/_template.md', 'templates/tmpl.md',
    'templates/_template.md', 'dashboards/dash.md', 'raw/README.md',
    'raw/promoted-item.md', 'raw/projects/proj-raw.md', 'raw/workflows/flow-raw.md',
    'raw/projects/client/examples/cap-draft.md',
    'raw/projects/client/examples/cap-inline.md',
    'raw/projects/client/examples/cap-list.md',
    'raw/projects/client/examples/cap-front.md',
    'wiki/projects/proj-a.md', 'wiki/projects/nested/deep.md',
    'wiki/workflows/flow-a.md', 'wiki/workflows/flow-a/examples/ex-1.md',
  ]) {
    await touch(rel, daysAgo(20));
  }
  // newer of the two drafts — makes drafts[] ordering deterministic
  await touch('raw/projects/client/examples/cap-draft2.md', new Date(daysAgo(20).getTime() + 3600e3));
  await touch('wiki/page-a.md', now); // today
  await touch('wiki/promoted-item.md', daysAgo(1)); // yesterday
  await touch('raw/note-b.md', daysAgo(1)); // yesterday

  metrics = await computeMetrics(createConfig({ REPO_ROOT: root }), now);

  // Second fixture: no Git and deliberately mixed lineage quality.
  bare = await fs.mkdtemp(path.join(os.tmpdir(), 'aos-metrics-bare-'));
  await write(bare, 'wiki/solo.md', origin('solo', now, '# Solo\n'));
  await write(bare, 'wiki/unlineaged.md', '# Missing lineage\n');
  await write(bare, 'raw/partial.md', '---\nsource_id: partial\n---\n# Missing date\n');
  await write(
    bare,
    'wiki/orphan-promotion.md',
    promotedFrom('raw/does-not-exist.md', '# Broken promotion\n')
  );
  await write(bare, 'raw/conflict-a.md', origin('conflict', daysAgo(2), '# Conflict A\n'));
  await write(bare, 'raw/conflict-b.md', origin('conflict', daysAgo(1), '# Conflict B\n'));
  await write(
    bare,
    'raw/future.md',
    origin('future', new Date(now.getTime() + DAY_MS), '# Future-dated\n')
  );
  await write(
    bare,
    'wiki/unsafe-promotion.md',
    promotedFrom('raw/../secrets.md', '# Unsafe promotion path\n')
  );
  await write(
    bare,
    'wiki/ambiguous.md',
    [
      '---',
      'source_id: ambiguous',
      `knowledge_intake_date: ${isoDay(now)}`,
      'promoted_from: raw/conflict-a.md',
      '---',
      '# Both origin and promotion',
      '',
    ].join('\n')
  );
  await write(
    bare,
    'raw/broken-frontmatter.md',
    '---\ntags:\n* invalid-yaml-alias\n---\nRAW BODY MUST NOT LEAK\n'
  );

  // Third fixture: `knowledge_intake_date` lexical strictness. YAML turns every
  // one of these into a Date, so only the frontmatter *source text* separates a
  // plain intake date from a timestamp or an impossible calendar day.
  strict = await fs.mkdtemp(path.join(os.tmpdir(), 'aos-metrics-strict-'));
  const lastYear = now.getFullYear() - 1;
  const past = isoDay(daysAgo(50));
  const dated = (id, literal) =>
    ['---', `source_id: ${id}`, `knowledge_intake_date: ${literal}`, '---', `# ${id}`, ''].join('\n');
  await write(strict, 'wiki/plain.md', dated('plain', past));
  await write(strict, 'wiki/quoted.md', dated('quoted', `'${past}'`));
  await write(strict, 'raw/zoned.md', dated('zoned', `${past}T10:00:00Z`));
  await write(strict, 'raw/unzoned.md', dated('unzoned', `${past}T10:00:00`));
  await write(strict, 'raw/spaced.md', dated('spaced', `${past} 10:00:00`));
  await write(strict, 'raw/overflow-day.md', dated('overflow-day', `${lastYear}-02-30`));
  await write(strict, 'raw/overflow-month.md', dated('overflow-month', `${lastYear}-13-01`));
  await write(strict, 'raw/not-a-date.md', dated('not-a-date', 'sometime last week'));

  // Fourth fixture: the lineage *graph* — fan-in, chains, cycles, duplicate
  // source IDs, and a conflict reached only by inheritance.
  graph = await fs.mkdtemp(path.join(os.tmpdir(), 'aos-metrics-graph-'));
  await write(graph, 'raw/src-one.md', origin('src-one', daysAgo(6), '# One\n'));
  await write(graph, 'raw/src-two.md', origin('src-two', daysAgo(4), '# Two\n'));
  // same source ID *and* same date, declared twice → one intake event
  await write(graph, 'raw/dup-one.md', origin('src-one', daysAgo(6), '# One again\n'));
  // fan-in: one published page derived from two distinct origins
  await write(
    graph,
    'wiki/multi.md',
    ['---', 'promoted_from:', '  - raw/src-one.md', '  - raw/src-two.md', '---', '# Multi', ''].join('\n')
  );
  // recursive chain: wiki → raw → raw origin
  await write(graph, 'raw/chain-mid.md', promotedFrom('raw/src-one.md', '# Mid\n'));
  await write(graph, 'wiki/chain-end.md', promotedFrom('raw/chain-mid.md', '# End\n'));
  // cycles: a file promoted from itself, and a two-node loop
  await write(graph, 'raw/self.md', promotedFrom('raw/self.md', '# Self\n'));
  await write(graph, 'raw/loop-a.md', promotedFrom('raw/loop-b.md', '# Loop A\n'));
  await write(graph, 'raw/loop-b.md', promotedFrom('raw/loop-a.md', '# Loop B\n'));
  // one source ID with two different dates, inherited by a fan-in promotion
  await write(graph, 'raw/split-a.md', origin('split', daysAgo(6), '# Split A\n'));
  await write(graph, 'raw/split-b.md', origin('split', daysAgo(3), '# Split B\n'));
  await write(
    graph,
    'wiki/inherits-conflict.md',
    ['---', 'promoted_from:', '  - raw/split-a.md', '  - raw/split-b.md', '---', '# Inherited', ''].join('\n')
  );
  graphMetrics = await computeMetrics(createConfig({ REPO_ROOT: graph }), now);

  // Fifth fixture: more diagnostic debt than the API is allowed to expose.
  problemCap = await fs.mkdtemp(path.join(os.tmpdir(), 'aos-metrics-problem-cap-'));
  await write(
    problemCap,
    'raw/structural.md',
    '---\ntags:\n* invalid-yaml-alias\n---\nDO NOT EXPOSE THIS BODY\n'
  );
  for (let i = 0; i < 25; i++) {
    await write(problemCap, `wiki/item-${String(i).padStart(2, '0')}.md`, '# No lineage\n');
  }
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(bare, { recursive: true, force: true });
  await fs.rm(strict, { recursive: true, force: true });
  await fs.rm(graph, { recursive: true, force: true });
  await fs.rm(problemCap, { recursive: true, force: true });
});

test('scalar counts follow the canonical skip/count rules', () => {
  assert.equal(metrics.wikiN, 6); // page-a, promoted-item, proj-a, deep, flow-a, ex-1
  assert.equal(metrics.rawN, 9); // 10 raw pages minus README; .gitkeep never a page
  assert.equal(metrics.examples, 1); // ex-1
  assert.equal(metrics.projects, 2); // proj-a + nested/deep, no skip filter
  assert.equal(metrics.workflows, 1); // flow-a; ex-1 is an example, not a workflow
  assert.equal(metrics.rawProj, 6); // proj-raw + the five captures
  assert.equal(metrics.rawFlow, 1);
});

test('`all` counts active memory tiers and ignores the retired dashboards root', () => {
  // 9 wiki + 10 raw + 2 templates = 21, minus the two _template.
  // The residual dashboards fixture must not contribute.
  assert.equal(metrics.all, 19);
});

test('`all` double-counts a promoted item (raw source AND wiki synthesis, ADR-0003)', async () => {
  const rawCopy = path.join(root, 'raw/promoted-item.md');
  const saved = await fs.readFile(rawCopy);
  await fs.rm(rawCopy);
  try {
    const without = await computeMetrics(createConfig({ REPO_ROOT: root }), now);
    // removing the raw twin drops `all` by exactly one → both copies counted
    assert.equal(without.all, metrics.all - 1);
    assert.equal(without.wikiN, metrics.wikiN); // wiki side untouched
  } finally {
    await fs.writeFile(rawCopy, saved);
    await touch('raw/promoted-item.md', daysAgo(20));
  }
});

test('knowledge intake deduplicates promotions by explicit lineage', () => {
  assert.equal(metrics.knowledgeN, 14); // 15 eligible files - 1 promoted copy
  assert.deepEqual(metrics.lineage, {
    eligibleN: 15,
    lineagedN: 15,
    unlineagedN: 0,
    invalidN: 0,
    promotedN: 1,
    conflictingSourceIdsN: 0,
    futureDatedSourceIdsN: 0,
    problems: [],
  });
});

test('captures: approval via the canonical status rule (inline, list item, frontmatter)', () => {
  assert.equal(metrics.capN, 5);
  assert.equal(metrics.apprN, 3);
  assert.equal(metrics.draftN, 2);
  assert.deepEqual(
    metrics.drafts.map((d) => d.name),
    ['cap-draft2', 'cap-draft'] // newest mtime first
  );
  assert.equal(metrics.drafts[0].path, 'raw/projects/client/examples/cap-draft2.md');
});

test('drafts[] is capped by DRAFT_LIMIT; draftN still counts the whole queue', async () => {
  const config = { ...createConfig({ REPO_ROOT: root }), DRAFT_LIMIT: 1 };
  const capped = await computeMetrics(config, now);
  assert.equal(capped.draftN, 2); // cap trims the list, not the count
  assert.deepEqual(
    capped.drafts.map((d) => d.name),
    ['cap-draft2'] // the newest draft survives the cap
  );
});

test('isApprovedText applies the first status marker exactly', () => {
  assert.equal(isApprovedText('Status: Approved'), true);
  assert.equal(isApprovedText('  status :  approved'), true);
  assert.equal(isApprovedText('Status:\n- Approved'), true);
  assert.equal(isApprovedText('Status:\n  * approved'), true);
  assert.equal(isApprovedText('---\nstatus: approved\n---\nbody'), true);
  assert.equal(isApprovedText('Status: Draft'), false);
  assert.equal(isApprovedText('Status: Draft\nStatus: Approved'), false); // first match wins
  assert.equal(isApprovedText('no marker at all'), false);
  assert.equal(isApprovedText(''), false);
});

test('30-day growth series is cumulative by distinct knowledge intake date', () => {
  assert.equal(metrics.series.length, 30);
  assert.equal(metrics.series[0].d, isoDay(daysAgo(29)));
  assert.equal(metrics.series[29].d, isoDay(now));
  assert.equal(metrics.series[0].v, 2); // the two origins from 40d ago
  assert.equal(metrics.series[18].v, 2); // day now-11: still only batch 1
  assert.equal(metrics.series[19].v, 10); // day now-10: + 8 raw origins
  assert.equal(metrics.series[27].v, 14); // day now-2: +4 origins; promotion adds zero
  assert.equal(metrics.series[29].v, metrics.knowledgeN);
  assert.equal(metrics.last30, 12); // 8 raw origins + 4 direct wiki origins
  // Rewritten mtimes and the later wiki publish path do not move intake.
  assert.equal(metrics.series[28].v, 14);
});

test('7-day week/weekTotal/activeDays derive from mtime', () => {
  assert.equal(metrics.week.length, 7);
  assert.equal(metrics.week[6].d, isoDay(now));
  assert.equal(metrics.week[6].c, 1); // page-a today
  assert.equal(metrics.week[5].c, 2); // promoted-item + note-b yesterday
  assert.equal(metrics.weekTotal, 3);
  assert.equal(metrics.activeDays, 2);
  assert.equal(metrics.trend, 'ACTIVE');
});

test('recent activity is top-N across all tiers by mtime', () => {
  assert.equal(metrics.recent.length, 6); // RECENT_ACTIVITY_LIMIT
  assert.equal(metrics.recent[0].name, 'page-a');
  assert.deepEqual(
    metrics.recent.slice(1, 3).map((r) => r.name).sort(),
    ['note-b', 'promoted-item']
  );
});

test('health comes from the FIRST lint entry in wiki/log.md', () => {
  assert.equal(metrics.health.lastLint, isoDay(daysAgo(3)));
  assert.equal(metrics.health.lintAge, 3);
  assert.equal(metrics.health.healthStale, false); // 3 < LINT_STALE_DAYS=7
  assert.equal(metrics.health.ageLabel, '3 DAYS AGO');
  assert.equal(metrics.health.staleDays, 7);
});

test('gauge targets use the canonical target helper', () => {
  assert.equal(target(0), 5);
  assert.equal(target(4), 5);
  assert.equal(target(5), 10); // strictly above v
  assert.equal(target(23), 25);
  assert.equal(metrics.targets.wikiN, target(metrics.wikiN));
  assert.equal(metrics.targets.rawN, target(metrics.rawN));
  assert.equal(metrics.targets.weekTotal, target(metrics.weekTotal));
});

test('lineage metrics do not depend on Git and expose incomplete or conflicting metadata', async () => {
  const m = await computeMetrics(createConfig({ REPO_ROOT: bare }), now);
  assert.equal(m.knowledgeN, 1);
  assert.equal(m.series[29].v, 1);
  assert.deepEqual(m.lineage, {
    eligibleN: 10,
    lineagedN: 1,
    unlineagedN: 1,
    invalidN: 8,
    promotedN: 0,
    conflictingSourceIdsN: 1,
    futureDatedSourceIdsN: 1,
    problems: [
      { path: 'raw/conflict-a.md', reason: 'conflicting-source-id' },
      { path: 'raw/conflict-b.md', reason: 'conflicting-source-id' },
      { path: 'raw/future.md', reason: 'future-intake-date' },
      { path: 'raw/broken-frontmatter.md', reason: 'invalid-frontmatter' },
      { path: 'wiki/unlineaged.md', reason: 'missing-lineage' },
      { path: 'wiki/orphan-promotion.md', reason: 'missing-promoted-from' },
      { path: 'wiki/ambiguous.md', reason: 'origin-and-promotion' },
      { path: 'raw/partial.md', reason: 'partial-origin' },
      { path: 'wiki/unsafe-promotion.md', reason: 'unsafe-promoted-from' },
    ],
  });
  assert.ok(m.lineage.problems.every((problem) => (
    Object.keys(problem).join(',') === 'path,reason'
  )));
  assert.doesNotMatch(JSON.stringify(m.lineage.problems), /RAW BODY MUST NOT LEAK/);
  assert.equal(m.health.lastLint, null); // no wiki/log.md
  assert.equal(m.health.healthStale, true);
  assert.equal(m.health.ageLabel, 'NEVER');
});

test('knowledge_intake_date accepts only a lexical YYYY-MM-DD scalar', async () => {
  const m = await computeMetrics(createConfig({ REPO_ROOT: strict }), now);
  // Only the bare scalar survives. Quotes, timestamps
  // (zoned/unzoned/space-separated), and calendar overflows (Feb 30, month 13)
  // are metadata defects, not exact YYYY-MM-DD source representations.
  assert.equal(m.knowledgeN, 1);
  assert.equal(m.lineage.eligibleN, 8);
  assert.equal(m.lineage.lineagedN, 1);
  assert.equal(m.lineage.unlineagedN, 0);
  assert.equal(m.lineage.invalidN, 7);
  assert.equal(m.lineage.futureDatedSourceIdsN, 0); // rejected outright, not "future"
  assert.deepEqual(
    m.lineage.problems.map(({ reason }) => reason),
    Array(7).fill('invalid-intake-date')
  );
  assert.equal(m.series[29].v, 1);
  assert.equal(m.last30, 0); // the valid intake is 50 days old
});

test('a promotion from several origins inherits all of them and mints no new intake', () => {
  // src-one + src-two are the only surviving intakes; wiki/multi adds neither.
  assert.equal(graphMetrics.knowledgeN, 2);
  assert.equal(graphMetrics.series[29].v, 2);
  assert.equal(graphMetrics.series[25].v, 2); // now-4: src-two joins
  assert.equal(graphMetrics.series[24].v, 1); // now-5: src-one only
  assert.equal(graphMetrics.series[22].v, 0); // now-7: before either origin
  assert.equal(graphMetrics.last30, 2);
});

test('a recursive promotion chain resolves through to the raw origin', () => {
  // wiki/chain-end → raw/chain-mid → raw/src-one, all three lineaged, no new event.
  assert.equal(graphMetrics.lineage.promotedN, 3); // multi + chain-mid + chain-end
  assert.equal(graphMetrics.lineage.lineagedN, 6); // + src-one, src-two, dup-one
  assert.equal(graphMetrics.knowledgeN, 2);
});

test('the same source_id declared twice at the same date counts once', async () => {
  const withoutDup = path.join(graph, 'raw/dup-one.md');
  const saved = await fs.readFile(withoutDup);
  await fs.rm(withoutDup);
  try {
    const m = await computeMetrics(createConfig({ REPO_ROOT: graph }), now);
    // one fewer eligible/lineaged file, identical knowledge — dedup by source_id
    assert.equal(m.lineage.eligibleN, graphMetrics.lineage.eligibleN - 1);
    assert.equal(m.lineage.lineagedN, graphMetrics.lineage.lineagedN - 1);
    assert.equal(m.knowledgeN, graphMetrics.knowledgeN);
    assert.deepEqual(m.series, graphMetrics.series);
  } finally {
    await fs.writeFile(withoutDup, saved);
  }
});

test('promotion cycles are invalid lineage, not infinite recursion', () => {
  // raw/self → itself; raw/loop-a ↔ raw/loop-b. None resolves to an origin.
  assert.equal(graphMetrics.lineage.invalidN, 6); // 3 cycle files + split-a/b + inherited
  assert.equal(graphMetrics.lineage.unlineagedN, 0);
  assert.equal(
    graphMetrics.lineage.lineagedN + graphMetrics.lineage.unlineagedN + graphMetrics.lineage.invalidN,
    graphMetrics.lineage.eligibleN
  );
  assert.equal(graphMetrics.lineage.eligibleN, 12);
  assert.deepEqual(
    graphMetrics.lineage.problems
      .filter(({ reason }) => reason === 'promotion-cycle')
      .map(({ path: problemPath }) => problemPath),
    ['raw/loop-a.md', 'raw/loop-b.md', 'raw/self.md']
  );
});

test('a source_id with conflicting dates poisons its origins and anything inheriting them', () => {
  assert.equal(graphMetrics.lineage.conflictingSourceIdsN, 1); // "split"
  assert.equal(graphMetrics.lineage.futureDatedSourceIdsN, 0);
  // The conflict never reaches the chart: no intake event is invented for it.
  assert.equal(graphMetrics.knowledgeN, 2);
  assert.ok(graphMetrics.series.every((point) => point.v <= 2));
  assert.deepEqual(
    graphMetrics.lineage.problems
      .filter(({ reason }) => reason === 'conflicting-source-id')
      .map(({ path: problemPath }) => problemPath),
    ['raw/split-a.md', 'raw/split-b.md', 'wiki/inherits-conflict.md']
  );
});

test('lineage problems are deterministically ordered and capped at 20', async () => {
  const m = await computeMetrics(createConfig({ REPO_ROOT: problemCap }), now);
  assert.equal(m.lineage.unlineagedN + m.lineage.invalidN, 26);
  assert.equal(m.lineage.problems.length, 20);
  assert.deepEqual(m.lineage.problems[0], {
    path: 'raw/structural.md',
    reason: 'invalid-frontmatter',
  });
  assert.deepEqual(
    m.lineage.problems.slice(1).map(({ path: problemPath }) => problemPath),
    Array.from({ length: 19 }, (_, i) => `wiki/item-${String(i).padStart(2, '0')}.md`)
  );
  assert.doesNotMatch(JSON.stringify(m.lineage.problems), /DO NOT EXPOSE THIS BODY/);
});

test('a missing scan root is treated as an empty collection', async () => {
  const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aos-metrics-empty-'));
  try {
    const m = await computeMetrics(createConfig({ REPO_ROOT: emptyRoot }), now);
    assert.equal(m.all, 0);
    assert.equal(m.lineage.eligibleN, 0);
  } finally {
    await fs.rm(emptyRoot, { recursive: true, force: true });
  }
});

test('a non-ENOENT scan error propagates instead of claiming empty metrics', async () => {
  const invalidRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aos-metrics-enotdir-'));
  try {
    await fs.writeFile(path.join(invalidRoot, 'wiki'), 'not a directory\n');
    await assert.rejects(
      computeMetrics(createConfig({ REPO_ROOT: invalidRoot }), now),
      { code: 'ENOTDIR' }
    );
  } finally {
    await fs.rm(invalidRoot, { recursive: true, force: true });
  }
});

test('GET /api/metrics returns the documented fields', async () => {
  const app = createApp(createConfig({ REPO_ROOT: root }));
  const res = await request(app).get('/api/metrics').set('Host', '127.0.0.1:3001');
  assert.equal(res.status, 200);
  const m = res.body;
  for (const field of [
    'wikiN', 'rawN', 'all', 'examples', 'projects', 'workflows', 'rawProj', 'rawFlow',
    'capN', 'draftN', 'apprN', 'drafts', 'knowledgeN', 'lineage',
    'series', 'last30', 'week', 'weekTotal',
    'activeDays', 'recent', 'health', 'targets', 'trend', 'generatedAt',
  ]) {
    assert.ok(field in m, `missing field: ${field}`);
  }
  assert.equal(m.wikiN, 6);
  assert.equal(m.series.length, 30);
  assert.equal(m.week.length, 7);
});
