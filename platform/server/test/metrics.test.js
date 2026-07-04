import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import request from 'supertest';
import { computeMetrics, isApprovedText, target } from '../src/metrics.js';
import { getPathAddedDates } from '../src/gitdates.js';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date();
const daysAgo = (n) => new Date(now.getTime() - n * DAY_MS);
const isoDay = (date) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

let root; // fixture git repo
let bare; // fixture without git (fallback behavior)
let metrics;

async function write(base, rel, content = `# ${rel}\n`) {
  const abs = path.join(base, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

function commitAll(cwd, date) {
  const iso = date.toISOString();
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: iso,
    GIT_COMMITTER_DATE: iso,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  execFileSync('git', ['add', '-A'], { cwd, env });
  execFileSync('git', ['commit', '-q', '-m', iso], { cwd, env });
}

async function touch(rel, date) {
  await fs.utimes(path.join(root, rel), date, date);
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'aos-metrics-fixture-'));
  execFileSync('git', ['init', '-q'], { cwd: root });

  // ---- batch 1, added 40 days ago (before the 30-day window) ----
  // `all`-members here: index, log, page-a, tmpl, dash, README, note-b = 7
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
  await write(root, 'wiki/page-a.md');
  await write(root, 'templates/tmpl.md');
  await write(root, 'templates/_template.md'); // excluded from all
  await write(root, 'dashboards/dash.md');
  await write(root, 'raw/README.md'); // skipped in rawN, counted in all
  await write(root, 'raw/note-b.md');
  await write(root, 'raw/assets/.gitkeep', ''); // not a page at all
  commitAll(root, daysAgo(40));

  // ---- batch 2, added 10 days ago: raw side (8 all-members) ----
  await write(root, 'raw/promoted-item.md'); // raw source of the promoted item
  await write(root, 'raw/projects/proj-raw.md');
  await write(root, 'raw/workflows/flow-raw.md');
  await write(root, 'raw/projects/client/examples/cap-draft.md', '# capture\nno status yet\n');
  await write(root, 'raw/projects/client/examples/cap-draft2.md', '# capture\nStatus: Draft\n');
  await write(root, 'raw/projects/client/examples/cap-inline.md', '# capture\nStatus: Approved\n');
  await write(root, 'raw/projects/client/examples/cap-list.md', '# capture\nStatus:\n- Approved\n');
  await write(
    root,
    'raw/projects/client/examples/cap-front.md',
    '---\nstatus: approved\n---\n# capture\n'
  );
  commitAll(root, daysAgo(10));

  // ---- batch 3, added 2 days ago: wiki side, incl. the promotion (5) ----
  // ADR-0003: the promotion lands as a NEW wiki path on the promotion date;
  // the raw original stays (raw is append-only).
  await write(root, 'wiki/promoted-item.md');
  await write(root, 'wiki/projects/proj-a.md');
  await write(root, 'wiki/projects/nested/deep.md');
  await write(root, 'wiki/workflows/flow-a.md');
  await write(root, 'wiki/workflows/flow-a/examples/ex-1.md');
  commitAll(root, daysAgo(2));

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

  // second fixture: no git at all (creation falls back to birthtime/mtime)
  bare = await fs.mkdtemp(path.join(os.tmpdir(), 'aos-metrics-bare-'));
  await write(bare, 'wiki/solo.md');
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(bare, { recursive: true, force: true });
});

test('scalar counts follow the HUD skip/count rules', () => {
  assert.equal(metrics.wikiN, 6); // page-a, promoted-item, proj-a, deep, flow-a, ex-1
  assert.equal(metrics.rawN, 9); // 10 raw pages minus README; .gitkeep never a page
  assert.equal(metrics.examples, 1); // ex-1
  assert.equal(metrics.projects, 2); // proj-a + nested/deep, no skip filter (HUD)
  assert.equal(metrics.workflows, 1); // flow-a; ex-1 is an example, not a workflow
  assert.equal(metrics.rawProj, 6); // proj-raw + the five captures
  assert.equal(metrics.rawFlow, 1);
});

test('`all` counts files across tiers, keeps index/log/README, drops only _template', () => {
  // 9 wiki + 10 raw + 2 templates + 1 dashboards = 22, minus the two _template
  assert.equal(metrics.all, 20);
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

test('captures: approval via the HUD status regex (inline, list item, frontmatter)', () => {
  assert.equal(metrics.capN, 5);
  assert.equal(metrics.apprN, 3);
  assert.equal(metrics.draftN, 2);
  assert.deepEqual(
    metrics.drafts.map((d) => d.name),
    ['cap-draft2', 'cap-draft'] // newest mtime first
  );
  assert.equal(metrics.drafts[0].path, 'raw/projects/client/examples/cap-draft2.md');
});

test('isApprovedText matches the HUD regex exactly', () => {
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

test('30-day growth series is cumulative by pathAddedDate (ADR-0003)', () => {
  assert.equal(metrics.series.length, 30);
  assert.equal(metrics.series[0].d, isoDay(daysAgo(29)));
  assert.equal(metrics.series[29].d, isoDay(now));
  assert.equal(metrics.series[0].v, 7); // batch 1 (40d ago) predates the window
  assert.equal(metrics.series[18].v, 7); // day now-11: still only batch 1
  assert.equal(metrics.series[19].v, 15); // day now-10: + 8 raw-side adds
  assert.equal(metrics.series[27].v, 20); // day now-2: + 5 wiki-side adds
  assert.equal(metrics.series[29].v, metrics.all); // today: everything
  assert.equal(metrics.last30, 13); // batches 2+3
  // mtimes were rewritten to this week for some batch-1 files; the series
  // must NOT move (it is keyed on git path-add, not fs timestamps)
  assert.equal(metrics.series[28].v, 20);
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

test('gauge targets use the HUD target() helper', () => {
  assert.equal(target(0), 5);
  assert.equal(target(4), 5);
  assert.equal(target(5), 10); // strictly above v
  assert.equal(target(23), 25);
  assert.equal(metrics.targets.wikiN, target(metrics.wikiN));
  assert.equal(metrics.targets.rawN, target(metrics.rawN));
  assert.equal(metrics.targets.weekTotal, target(metrics.weekTotal));
});

test('non-git root: empty pathAdded map, creation falls back to fs timestamps', async () => {
  assert.equal((await getPathAddedDates(bare)).size, 0);
  const m = await computeMetrics(createConfig({ REPO_ROOT: bare }), now);
  assert.equal(m.wikiN, 1);
  assert.equal(m.series[29].v, m.all); // just-created file lands today
  assert.equal(m.health.lastLint, null); // no wiki/log.md
  assert.equal(m.health.healthStale, true);
  assert.equal(m.health.ageLabel, 'NEVER');
});

test('GET /api/metrics returns the documented fields', async () => {
  const app = createApp(createConfig({ REPO_ROOT: root }));
  const res = await request(app).get('/api/metrics').set('Host', '127.0.0.1:3001');
  assert.equal(res.status, 200);
  const m = res.body;
  for (const field of [
    'wikiN', 'rawN', 'all', 'examples', 'projects', 'workflows', 'rawProj', 'rawFlow',
    'capN', 'draftN', 'apprN', 'drafts', 'series', 'last30', 'week', 'weekTotal',
    'activeDays', 'recent', 'health', 'targets', 'trend', 'generatedAt',
  ]) {
    assert.ok(field in m, `missing field: ${field}`);
  }
  assert.equal(m.wikiN, 6);
  assert.equal(m.series.length, 30);
  assert.equal(m.week.length, 7);
});
