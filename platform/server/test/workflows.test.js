import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';

// Fixture repo exercising every status + the precedence order (ADR-0006/0007).
let root;

const FM = (kind, extra = '') =>
  `---\ntags: [workflow]\nupdated: 2026-07-01\n${kind ? `workflow_kind: ${kind}\n` : ''}${extra}---\n\n`;

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
  // Classified, indexed, clean, but old mtime → Stale.
  await write('wiki/workflows/old.md', FM('policy') + '# Old\n\nStill true, just old.\n');
  const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
  await fs.utimes(path.join(root, 'wiki/workflows/old.md'), old, old);
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
  const res = await get('/api/workflows');
  const plain = byPath(res.body)['wiki/workflows/plain.md'];
  assert.equal(plain.status, 'unclassified');
  assert.equal(plain.kind, null);
  assert.equal(plain.requiresVerification, null, 'kind booleans must not be derived');
  const verification = plain.checks.find((c) => c.id === 'verification');
  assert.equal(verification.status, 'n/a', 'kind-dependent check must be suppressed, not passed');
});

test('a kind-independent defect out-ranks Unclassified', async () => {
  const res = await get('/api/workflows');
  assert.equal(byPath(res.body)['wiki/workflows/plain-todo.md'].status, 'needs-review');
});

test('classified style-guide stays OK; runbook without verification is Needs review', async () => {
  const res = await get('/api/workflows');
  const rows = byPath(res.body);
  assert.equal(rows['wiki/workflows/style.md'].status, 'ok');
  assert.equal(rows['wiki/workflows/bad-runbook.md'].status, 'needs-review');
  assert.equal(
    rows['wiki/workflows/bad-runbook.md'].checks.find((c) => c.id === 'verification').status,
    'fail'
  );
});

test('eval-suite requires verification but not runbook shape', async () => {
  const res = await get('/api/workflows');
  const evals = byPath(res.body)['wiki/workflows/evals.md'];
  assert.equal(evals.status, 'ok');
  assert.equal(evals.checks.find((c) => c.id === 'runbook-shape').status, 'n/a');
});

test('status precedence holds: Missing links > Needs review > Unclassified > Stale > OK', async () => {
  const res = await get('/api/workflows');
  const rows = byPath(res.body);
  assert.equal(rows['wiki/workflows/unindexed.md'].status, 'missing-links');
  assert.equal(rows['wiki/workflows/old.md'].status, 'stale');
  assert.equal(rows['wiki/workflows/good-runbook.md'].status, 'ok');
  // summary counts every status honestly
  assert.equal(res.body.summary.total, res.body.workflows.length);
  assert.equal(res.body.summary['missing-links'], 1);
  assert.ok(res.body.summary.unclassified >= 1);
});

test('"Verification: not applicable" and checks_exempt are decisions, not defects', async () => {
  const res = await get('/api/workflows');
  const rows = byPath(res.body);
  assert.equal(rows['wiki/workflows/na-runbook.md'].status, 'ok');
  const exemptRow = rows['wiki/workflows/exempt-runbook.md'];
  assert.equal(exemptRow.status, 'ok');
  assert.equal(exemptRow.checks.find((c) => c.id === 'verification').status, 'exempt');
});

test('invalid workflow_kind is broken metadata (Needs review), not silently a kind', async () => {
  const res = await get('/api/workflows');
  const row = byPath(res.body)['wiki/workflows/badkind.md'];
  assert.equal(row.status, 'needs-review');
  assert.equal(row.kind, null);
  assert.match(row.checks.find((c) => c.id === 'metadata').detail, /workflow_kind/);
});

test('an accepted/standing TODO marker does not flag the workflow', async () => {
  const res = await get('/api/workflows');
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
