import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { getWorkflow, listWorkflows } from '../src/workflows.js';

// Fixture repo exercising every status + the precedence order (ADR-0006/0007).
let root;

// Staleness is measured from frontmatter `updated:` against `now`, so every
// status assertion runs at this pinned instant — never the wall clock, or a
// committed literal date would drift into Stale by itself. Literal dates
// below are relative to it (WORKFLOW_STALE_DAYS = 90).
const NOW = new Date('2026-11-14T12:00:00');
const DAY_MS = 24 * 60 * 60 * 1000;

// `updated` is written verbatim; null omits the line entirely.
const FM = (kind, extra = '', updated = '2026-11-01') =>
  `---\ntags: [workflow]\n${updated === null ? '' : `updated: ${updated}\n`}${kind ? `workflow_kind: ${kind}\n` : ''}${extra}---\n\n`;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflows-fixture-'));
  const write = async (rel, text) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  };

  // A clean classified runbook: indexed, verification + steps present.
  await write(
    'wiki/workflows/good-runbook.md',
    FM('runbook') + '# Good Runbook\n\n1. Do the thing.\n2. Check it.\n\n## Verification\nRun the checks.\n'
  );
  // A runbook with steps but NO stated validation method → Needs review.
  await write(
    'wiki/workflows/bad-runbook.md',
    FM('runbook') + '# Bad Runbook\n\n1. Do the thing.\n'
  );
  // A style-guide: never held to runbook ceremony → OK (ADR-0006).
  await write(
    'wiki/workflows/style.md',
    FM('style-guide') + '# Style Guide\n\nWrite informally.\n'
  );
  // An eval-suite: requires verification but NOT runbook shape.
  await write(
    'wiki/workflows/evals.md',
    FM('eval-suite') + '# Evals\n\n## Manual run checklist\nPick a case, feed its input, compare.\n'
  );
  // Un-annotated but structurally clean → Unclassified, never OK (ADR-0007).
  await write('wiki/workflows/plain.md', FM(null) + '# Plain\n\nSome procedure prose.\n');
  // Un-annotated + unaccepted TODO → Needs review outranks Unclassified.
  await write(
    'wiki/workflows/plain-todo.md',
    FM(null) + '# Plain Todo\n\nTODO: finish this section.\n'
  );
  // Classified + clean but NOT linked from index.md → Missing links wins.
  await write(
    'wiki/workflows/unindexed.md',
    FM('policy') + '# Unindexed\n\nA policy nobody indexed.\n'
  );
  // Classified, indexed, clean, `updated` 200 days before NOW, fresh mtime → Stale.
  await write('wiki/workflows/old.md', FM('policy', '', '2026-04-28') + '# Old\n\nStill true, just old.\n');
  // The inverse: `updated` is NOW's day but the file mtime is 200 days back
  // (a checkout, a copy) → OK. mtime is never evidence of age.
  await write('wiki/workflows/old-mtime.md', FM('policy', '', '2026-11-14') + '# Old Mtime\n\nJust reviewed.\n');
  const oldMtime = new Date(NOW.getTime() - 200 * DAY_MS);
  await fs.utimes(path.join(root, 'wiki/workflows/old-mtime.md'), oldMtime, oldMtime);
  // The 90-day boundary: exactly 90 days old is still OK, 91 is Stale.
  await write('wiki/workflows/edge-90.md', FM('policy', '', '2026-08-16') + '# Edge 90\n\nBody.\n');
  await write('wiki/workflows/edge-91.md', FM('policy', '', '2026-08-15') + '# Edge 91\n\nBody.\n');
  // A future `updated` is simply not stale.
  await write('wiki/workflows/future.md', FM('policy', '', '2027-01-01') + '# Future\n\nBody.\n');
  // Old but un-annotated → Unclassified outranks Stale.
  await write('wiki/workflows/old-plain.md', FM(null, '', '2026-04-28') + '# Old Plain\n\nProse.\n');
  // Old and not in index.md → Missing links outranks Stale.
  await write('wiki/workflows/old-unindexed.md', FM('policy', '', '2026-04-28') + '# Old Unindexed\n\nBody.\n');
  // Invalid `updated` values are broken metadata. YAML would roll 2026-13-45
  // over into a valid Date, so the value must be read as written.
  await write('wiki/workflows/bad-date.md', FM('policy', '', '2026-13-45') + '# Bad Date\n\nBody.\n');
  await write('wiki/workflows/not-a-date.md', FM('policy', '', 'not-a-date') + '# Not A Date\n\nBody.\n');
  // Missing `updated` is broken metadata (wiki-lint check 2), never a guess.
  await write('wiki/workflows/no-updated.md', FM('policy', '', null) + '# No Updated\n\nBody.\n');
  await write('wiki/workflows/no-updated-plain.md', FM(null, '', null) + '# No Updated Plain\n\nBody.\n');
  // Quoted and commented values read as the date they spell.
  await write('wiki/workflows/quoted.md', FM('policy', '', '"2026-11-02"') + '# Quoted\n\nBody.\n');
  // A due review-by date (wiki-lint check 25) is informational only.
  await write(
    'wiki/workflows/review-due.md',
    FM('policy') + '# Review Due\n\nA lesson to confirm. `review-by: 2026-01-31`\nLater: review-by: 2027-05-07\n'
  );
  await write('wiki/workflows/commented.md', FM('policy', '', '2026-11-03 # reviewed') + '# Commented\n\nBody.\n');
  // "Verification: not applicable" is a satisfying decision, never flagged.
  await write(
    'wiki/workflows/na-runbook.md',
    FM('runbook') + '# NA Runbook\n\n1. Step one.\n\nVerification: not applicable — pure lookup table.\n'
  );
  // checks_exempt opts a workflow out of a check that doesn't apply.
  await write(
    'wiki/workflows/exempt-runbook.md',
    FM('runbook', 'checks_exempt: [verification]\n') + '# Exempt Runbook\n\n1. Step one.\n'
  );
  // Invalid workflow_kind → broken metadata → Needs review.
  await write(
    'wiki/workflows/badkind.md',
    FM('command') + '# Bad Kind\n\nBody.\n'
  );
  // Nested (slashes in path) + accepted TODO marker stays clean.
  await write(
    'wiki/workflows/nested/deep.md',
    FM('policy') + '# Deep\n\nTODO (accepted): standing open question, deliberate.\n'
  );
  // Excluded data folders: never workflows, surfaced as related data.
  await write('wiki/workflows/style/examples/sample-a.md', '# Example A\n');
  await write('wiki/workflows/evals/cases/case-1.md', '# Case\n');
  await write('wiki/workflows/evals/results/2026-07-01.md', '# Result\n');

  const indexed = [
    'good-runbook',
    'bad-runbook',
    'style',
    'evals',
    'plain',
    'plain-todo',
    'old',
    'old-mtime',
    'edge-90',
    'edge-91',
    'future',
    'old-plain',
    'bad-date',
    'not-a-date',
    'no-updated',
    'no-updated-plain',
    'quoted',
    'commented',
    'review-due',
    'na-runbook',
    'exempt-runbook',
    'badkind',
  ]
    .map((n) => `- [${n}](workflows/${n}.md) — a workflow.`)
    .join('\n');
  await write('wiki/index.md', `# Index\n\n## Workflows\n${indexed}\n- [deep](workflows/nested/deep.md) — nested.\n`);
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const app = () => createApp(createConfig({ REPO_ROOT: root }));
const get = (url) => request(app()).get(url).set('Host', '127.0.0.1:3001');

const byPath = (body) => Object.fromEntries(body.workflows.map((w) => [w.path, w]));
// Every status assertion goes through the registry at the pinned NOW; the HTTP
// routes use the real clock, so tests through them assert age-independent
// things only (shape, rejections).
const list = () => listWorkflows(createConfig({ REPO_ROOT: root }), NOW);

test('registry excludes **/{examples,cases,results}/** from status verdicts', async () => {
  const res = await get('/api/workflows');
  assert.equal(res.status, 200);
  const paths = res.body.workflows.map((w) => w.path);
  assert.ok(paths.includes('wiki/workflows/nested/deep.md'), 'nested workflow missing');
  for (const p of paths) {
    assert.ok(!/\/(examples|cases|results)\//.test(p), `excluded data leaked into registry: ${p}`);
  }
});

test('un-annotated workflow is Unclassified — never OK, never inferred', async () => {
  const res = { body: await list() };
  const plain = byPath(res.body)['wiki/workflows/plain.md'];
  assert.equal(plain.status, 'unclassified');
  assert.equal(plain.kind, null);
  assert.equal(plain.requiresVerification, null, 'kind booleans must not be derived');
  const verification = plain.checks.find((c) => c.id === 'verification');
  assert.equal(verification.status, 'n/a', 'kind-dependent check must be suppressed, not passed');
});

test('a kind-independent defect out-ranks Unclassified', async () => {
  const res = { body: await list() };
  assert.equal(byPath(res.body)['wiki/workflows/plain-todo.md'].status, 'needs-review');
});

test('classified style-guide stays OK; runbook without verification is Needs review', async () => {
  const res = { body: await list() };
  const rows = byPath(res.body);
  assert.equal(rows['wiki/workflows/style.md'].status, 'ok');
  assert.equal(rows['wiki/workflows/bad-runbook.md'].status, 'needs-review');
  assert.equal(
    rows['wiki/workflows/bad-runbook.md'].checks.find((c) => c.id === 'verification').status,
    'fail'
  );
});

test('eval-suite requires verification but not runbook shape', async () => {
  const res = { body: await list() };
  const evals = byPath(res.body)['wiki/workflows/evals.md'];
  assert.equal(evals.status, 'ok');
  assert.equal(evals.checks.find((c) => c.id === 'runbook-shape').status, 'n/a');
});

test('status precedence holds: Missing links > Needs review > Unclassified > Stale > OK', async () => {
  const res = { body: await list() };
  const rows = byPath(res.body);
  assert.equal(rows['wiki/workflows/unindexed.md'].status, 'missing-links');
  assert.equal(rows['wiki/workflows/old.md'].status, 'stale');
  assert.equal(rows['wiki/workflows/good-runbook.md'].status, 'ok');
  // summary counts every status honestly
  assert.equal(res.body.summary.total, res.body.workflows.length);
  assert.equal(res.body.summary['missing-links'], 2);
  assert.ok(res.body.summary.unclassified >= 1);
});

test('"Verification: not applicable" and checks_exempt are decisions, not defects', async () => {
  const res = { body: await list() };
  const rows = byPath(res.body);
  assert.equal(rows['wiki/workflows/na-runbook.md'].status, 'ok');
  const exemptRow = rows['wiki/workflows/exempt-runbook.md'];
  assert.equal(exemptRow.status, 'ok');
  assert.equal(exemptRow.checks.find((c) => c.id === 'verification').status, 'exempt');
});

test('invalid workflow_kind is broken metadata (Needs review), not silently a kind', async () => {
  const res = { body: await list() };
  const row = byPath(res.body)['wiki/workflows/badkind.md'];
  assert.equal(row.status, 'needs-review');
  assert.equal(row.kind, null);
  assert.match(row.checks.find((c) => c.id === 'metadata').detail, /workflow_kind/);
});

test('an accepted/standing TODO marker does not flag the workflow', async () => {
  const res = { body: await list() };
  assert.equal(byPath(res.body)['wiki/workflows/nested/deep.md'].status, 'ok');
});

test('GET /api/workflow?path= resolves a slashed path with checks + related files', async () => {
  const res = await get('/api/workflow?path=' + encodeURIComponent('wiki/workflows/nested/deep.md'));
  assert.equal(res.status, 200);
  assert.equal(res.body.path, 'wiki/workflows/nested/deep.md');
  assert.ok(Array.isArray(res.body.checks));
  assert.equal(res.body.absolutePath, path.join(root, 'wiki/workflows/nested/deep.md'));

  const style = await get('/api/workflow?path=' + encodeURIComponent('wiki/workflows/style.md'));
  assert.deepEqual(style.body.relatedFiles, ['wiki/workflows/style/examples/sample-a.md']);
});

test('GET /api/workflow rejects traversal, non-workflow, and excluded-data paths', async () => {
  for (const p of ['../../etc/passwd', 'wiki/index.md', 'wiki/workflows/evals/cases/case-1.md']) {
    const res = await get('/api/workflow?path=' + encodeURIComponent(p));
    assert.equal(res.status, 400, p);
  }
  const missing = await get('/api/workflow?path=' + encodeURIComponent('wiki/workflows/nope.md'));
  assert.equal(missing.status, 404);
});

test('failing objective checks carry fix hints; unclassified rows carry the kind hint (§4.4)', async () => {
  const res = { body: await list() };
  const byPath = Object.fromEntries(res.body.workflows.map((w) => [w.path, w]));

  // bad-runbook fails verification → that check has a hint; passing checks do not.
  const bad = byPath['wiki/workflows/bad-runbook.md'];
  const verification = bad.checks.find((c) => c.id === 'verification');
  assert.equal(verification.status, 'fail');
  assert.ok(verification.fixHint && verification.fixHint.length > 0);
  for (const c of bad.checks.filter((x) => x.status !== 'fail')) {
    assert.equal(c.fixHint, undefined, `${c.id} must not carry a hint unless failing`);
  }

  // A clean un-annotated workflow gets the workflow-level classification hint.
  const plain = byPath['wiki/workflows/plain.md'];
  assert.equal(plain.status, 'unclassified');
  assert.match(plain.fixHint, /workflow_kind/);

  // A clean classified workflow carries no hint anywhere.
  const good = byPath['wiki/workflows/good-runbook.md'];
  assert.equal(good.fixHint, undefined);
  assert.ok(good.checks.every((c) => c.fixHint === undefined));
});

// ---- staleness from frontmatter `updated:` (never mtime) ----

test('Stale is measured from frontmatter updated:, never from the file mtime', async () => {
  const rows = byPath(await list());
  // 200 days old by `updated:`, freshly written → Stale (mtime said OK).
  assert.equal(rows['wiki/workflows/old.md'].status, 'stale');
  assert.equal(rows['wiki/workflows/old.md'].ageDays, 200);
  // Reviewed today by `updated:`, mtime 200 days back → OK (mtime said Stale).
  assert.equal(rows['wiki/workflows/old-mtime.md'].status, 'ok');
  assert.equal(rows['wiki/workflows/old-mtime.md'].ageDays, 0);
});

test('the 90-day threshold: exactly 90 days is OK, 91 is Stale, a future date is not stale', async () => {
  const rows = byPath(await list());
  assert.equal(rows['wiki/workflows/edge-90.md'].ageDays, 90);
  assert.equal(rows['wiki/workflows/edge-90.md'].status, 'ok');
  assert.equal(rows['wiki/workflows/edge-91.md'].ageDays, 91);
  assert.equal(rows['wiki/workflows/edge-91.md'].status, 'stale');
  assert.equal(rows['wiki/workflows/future.md'].status, 'ok');
  assert.ok(rows['wiki/workflows/future.md'].ageDays < 0);
});

test('an old updated: never out-ranks Unclassified or Missing links', async () => {
  const rows = byPath(await list());
  assert.equal(rows['wiki/workflows/old-plain.md'].status, 'unclassified');
  assert.equal(rows['wiki/workflows/old-unindexed.md'].status, 'missing-links');
});

test('an impossible or non-date updated: is broken metadata, reported as null', async () => {
  const rows = byPath(await list());
  for (const p of ['wiki/workflows/bad-date.md', 'wiki/workflows/not-a-date.md']) {
    const row = rows[p];
    assert.equal(row.status, 'needs-review', p);
    assert.equal(row.updated, null, p);
    assert.equal(row.ageDays, null, p);
    const metadata = row.checks.find((c) => c.id === 'metadata');
    assert.equal(metadata.status, 'fail', p);
    assert.match(metadata.detail, /updated .* is not a YYYY-MM-DD date/, p);
    assert.ok(metadata.fixHint, p);
  }
});

test('a missing updated: is broken metadata (wiki-lint check 2) and out-ranks Unclassified', async () => {
  const rows = byPath(await list());
  const row = rows['wiki/workflows/no-updated.md'];
  assert.equal(row.status, 'needs-review');
  assert.equal(row.updated, null);
  assert.match(row.checks.find((c) => c.id === 'metadata').detail, /updated is missing/);
  assert.equal(rows['wiki/workflows/no-updated-plain.md'].status, 'needs-review');
});

test('quoted and commented updated: values read as the date they spell', async () => {
  const rows = byPath(await list());
  assert.equal(rows['wiki/workflows/quoted.md'].updated, '2026-11-02');
  assert.equal(rows['wiki/workflows/quoted.md'].status, 'ok');
  assert.equal(rows['wiki/workflows/commented.md'].updated, '2026-11-03');
  assert.equal(rows['wiki/workflows/commented.md'].status, 'ok');
});

test('the payload carries updated + ageDays and no mtime', async () => {
  const body = await list();
  for (const w of body.workflows) {
    assert.equal(Object.hasOwn(w, 'mtime'), false, w.path);
    assert.ok(Object.hasOwn(w, 'updated') && Object.hasOwn(w, 'ageDays'), w.path);
  }
  assert.equal(byPath(body)['wiki/workflows/good-runbook.md'].updated, '2026-11-01');
  assert.equal(byPath(body)['wiki/workflows/good-runbook.md'].ageDays, 13);

  const one = await getWorkflow(createConfig({ REPO_ROOT: root }), 'wiki/workflows/old.md', NOW);
  assert.equal(one.status, 'stale');
  assert.equal(one.updated, '2026-04-28');
  assert.equal(Object.hasOwn(one, 'mtime'), false);
});

test('statuses do not change when every file mtime is touched (a fresh checkout)', async () => {
  const before = (await list()).workflows.map((w) => [w.path, w.status]);
  const { workflows } = await list();
  const fresh = new Date(NOW.getTime() - 60 * 1000);
  await Promise.all(workflows.map((w) => fs.utimes(path.join(root, w.path), fresh, fresh)));
  try {
    assert.deepEqual((await list()).workflows.map((w) => [w.path, w.status]), before);
  } finally {
    const old = new Date(NOW.getTime() - 200 * DAY_MS);
    await fs.utimes(path.join(root, 'wiki/workflows/old-mtime.md'), old, old);
  }
});

test('a due review-by date fails the informational check and leaves the status alone', async () => {
  const rows = byPath(await list());
  const row = rows['wiki/workflows/review-due.md'];
  assert.equal(row.status, 'ok');
  const check = row.checks.find((c) => c.id === 'review-by');
  assert.equal(check.category, 'informational');
  assert.equal(check.status, 'fail');
  // Lines count from the file's first line, frontmatter included (as lint does).
  assert.equal(check.detail, 'line 9: 2026-01-31 is due');
  assert.equal(check.fixHint, undefined);
  // A page with no review-by token, or only a future one, passes.
  assert.equal(rows['wiki/workflows/good-runbook.md'].checks.find((c) => c.id === 'review-by').status, 'pass');
});
