import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { listEvals, parseResultFile, EVAL_PROBLEM_LIMIT } from '../src/evals.js';
import { EXECUTABLE_ALLOWLIST } from '../src/operations.js';

// Synthetic fixture memory repo (ids and text are invented). The scanner
// mirrors memory-repo lint checks 9 and 23; the console never runs or judges
// an eval (ADR-0001), it only reads the recorded verdicts.

const FIELDS = (type = 'deterministic') =>
  `- target: a synthetic page\n- type: ${type}\n- must_include: met\n- must_not_include: clean\n` +
  `- verification: read the output\n- action taken: none — passed\n`;
const RESULT = (date, body, { full = false } = {}) =>
  `---\ntags: [eval]\nupdated: ${date}\n---\n# Eval Results — ${date}\n\n> Synthetic.\n\n` +
  (full ? 'Run: full monthly suite\n\n' : '') +
  body;
const CASE = (id, type, title) =>
  `---\ntags: [eval]\n---\n# ${title}\n\n\`\`\`yaml\n${id ? `id: ${id}\n` : ''}type: ${type}\n\`\`\`\n`;

async function makeRepo(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-fixture-'));
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  }
  return root;
}

const R = 'wiki/workflows/evals/results';
const C = 'wiki/workflows/evals/cases';
const roots = [];
let root;

before(async () => {
  root = await makeRepo({
    'wiki/index.md': '# Index\n\n- [Evals](workflows/evals.md)\n',
    'wiki/workflows/evals.md':
      '---\nworkflow_kind: eval-suite\nupdated: 2026-01-01\n---\n# Evals\n\n## Manual run checklist\nPick a case.\n',
    [`${C}/alpha.md`]: CASE('eval-alpha', 'deterministic', 'Eval — Alpha'),
    [`${C}/beta.md`]: CASE('eval-beta', 'judgment', 'Eval — Beta'),
    [`${C}/gamma.md`]: CASE(null, 'mixed', 'Eval — Gamma'), // fallback id eval-gamma, never run
    [`${C}/README.md`]: '# Cases\n',
    [`${R}/README.md`]:
      '# Eval Results\n\n```markdown\n## eval-<slug> — PASS | FAIL\n```\n\n## Convention\n',
    [`${R}/_template.md`]: '## not a run\n',
    [`${R}/2026-01-10.md`]: RESULT(
      '2026-01-10',
      `## eval-alpha — PASS\n${FIELDS()}\n` +
        `## eval-beta — PARTIAL (first run)\n${FIELDS('judgment')}\n` +
        `## eval-retired (fixture A only) — PASS\n${FIELDS('mixed')}`
    ),
    [`${R}/2026-02-07.md`]: RESULT(
      '2026-02-07',
      `## eval-beta — PASS (rerun)\n${FIELDS('judgment')}- Confirmed by: owner, 2026-02-07\n\n` +
        `## eval-beta — FAIL\n${FIELDS('judgment')}\n` +
        `## eval-alpha — PASS\n${FIELDS()}`,
      { full: true }
    ),
  });
  roots.push(root);
});

after(async () => {
  await Promise.all(roots.map((r) => fs.rm(r, { recursive: true, force: true })));
});

const NOW = new Date(2026, 1, 20, 12); // local 2026-02-20

test('happy path: ids grouped, runs date-desc then file order, latest, counts', async () => {
  const out = await listEvals(createConfig({ REPO_ROOT: root }), NOW);
  assert.deepEqual(out.evals.map((e) => e.id), ['eval-alpha', 'eval-beta', 'eval-gamma', 'eval-retired']);
  const beta = out.evals.find((e) => e.id === 'eval-beta');
  assert.deepEqual(
    beta.runs.map((r) => [r.date, r.verdict, r.note]),
    [
      ['2026-02-07', 'PASS', 'rerun'],
      ['2026-02-07', 'FAIL', null],
      ['2026-01-10', 'PARTIAL', 'first run'],
    ]
  );
  assert.deepEqual(beta.latest, { verdict: 'PASS', date: '2026-02-07' });
  assert.equal(beta.lastRunDate, '2026-02-07');
  assert.deepEqual(beta.counts, { PASS: 1, PARTIAL: 1, FAIL: 1 });
  assert.deepEqual(beta.case, { path: `${C}/beta.md`, title: 'Eval — Beta', type: 'judgment' });
  assert.equal(beta.runs[0].confirmed, true);
  assert.equal(beta.runs[1].confirmed, false);
  assert.equal(beta.runs[0].type, 'judgment');
  assert.equal(beta.runs[0].path, `${R}/2026-02-07.md`);
  assert.equal(typeof beta.runs[0].line, 'number');
  assert.deepEqual(beta.runs[0].missingFields, []);

  const gamma = out.evals.find((e) => e.id === 'eval-gamma');
  assert.deepEqual(gamma.runs, []);
  assert.equal(gamma.latest, null);
  assert.equal(gamma.lastRunDate, null);
  assert.equal(gamma.case.type, 'mixed');

  const retired = out.evals.find((e) => e.id === 'eval-retired');
  assert.equal(retired.case, null);
  assert.equal(retired.runs[0].subject, 'fixture A only');

  assert.deepEqual(out.suite, {
    cases: 3,
    resultFiles: 2,
    runs: 6,
    lastRunDate: '2026-02-07',
    fullSuiteDates: ['2026-02-07'],
    lastFullSuiteDate: '2026-02-07',
    neverFullSuite: false,
    ageDays: 13,
    dueDays: 28,
    due: false,
    neverRun: ['eval-gamma'],
    withoutCase: ['eval-retired'],
  });
  assert.equal(out.problemCount, 0);
  assert.deepEqual(out.problems, []);
  assert.match(out.orderNote, /date, not a time/);
});

test('both optional qualifiers parse: after the slug and after the verdict', () => {
  const text = RESULT(
    '2026-03-01',
    `## eval-a (fixture D only) — PASS\n${FIELDS()}\n## eval-a — FAIL (Q1)\n${FIELDS()}\n` +
      `## eval-a (subject) — PARTIAL (note)\n${FIELDS()}`
  );
  const { runs, problems } = parseResultFile('r.md', '2026-03-01', text);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    runs.map((r) => [r.subject, r.verdict, r.note]),
    [
      ['fixture D only', 'PASS', null],
      [null, 'FAIL', 'Q1'],
      ['subject', 'PARTIAL', 'note'],
    ]
  );
});

test('strip_code mirror: a fenced heading is no run; an inline-code slug is malformed', () => {
  const text = RESULT(
    '2026-03-01',
    `## eval-a — PASS\n${FIELDS()}\n\`\`\`markdown\n## eval-fenced — PASS\n- target: x\n\`\`\`\n\n` +
      '## `eval-b` — PASS\n' +
      FIELDS()
  );
  const { runs, problems, looseIds } = parseResultFile('r.md', '2026-03-01', text);
  assert.deepEqual(runs.map((r) => r.id), ['eval-a']);
  assert.deepEqual(problems.map((p) => p.reason), ['malformed-heading']);
  assert.ok(!looseIds.includes('eval-fenced'));
});

test('malformed headings: problem with line, no run, fields do not leak into the previous block', () => {
  const text = RESULT(
    '2026-03-01',
    '## eval-a — PASS\n- target: x\n\n' +
      `## eval-a - PASS\n${FIELDS()}\n` +
      `## eval-a — SKIPPED\n${FIELDS()}\n` +
      `## eval-UPPER — PASS\n${FIELDS()}`
  );
  const lines = text.split('\n');
  const { runs, problems } = parseResultFile('r.md', '2026-03-01', text);
  assert.equal(runs.length, 1);
  // The well-formed block only had `target`: the malformed blocks' fields did not attach.
  assert.deepEqual(runs[0].missingFields, ['type', 'must_include', 'must_not_include', 'verification', 'action taken']);
  const malformed = problems.filter((p) => p.reason === 'malformed-heading');
  assert.equal(malformed.length, 3);
  for (const p of malformed) assert.ok(lines[p.line - 1].startsWith('## eval-'));
  assert.equal(lines[malformed[0].line - 1], '## eval-a - PASS');
});

test('missing-fields lists exactly the missing names; continuation lines create no fields', () => {
  const text = RESULT(
    '2026-03-01',
    '## eval-a — PASS\n- target: x\n  - verification: wrapped continuation, not a field\n- type: judgment\n' +
      '- must_include: met\n- action taken: none\n'
  );
  const { runs, problems } = parseResultFile('r.md', '2026-03-01', text);
  assert.deepEqual(runs[0].missingFields, ['must_not_include', 'verification']);
  assert.deepEqual(problems, [{ path: 'r.md', line: runs[0].line, reason: 'missing-fields' }]);
  assert.equal(runs[0].type, 'judgment');
});

test('filename, H1 and empty-file problems; README/_template ignored silently', async () => {
  const r = await makeRepo({
    [`${R}/notes.md`]: RESULT('2026-01-01', `## eval-a — PASS\n${FIELDS()}`),
    [`${R}/2026-02-30.md`]: RESULT('2026-02-30', `## eval-a — PASS\n${FIELDS()}`),
    [`${R}/2026-03-01.md`]: `# Eval Results — 2026-03-02\n\n## eval-a — PASS\n${FIELDS()}`,
    [`${R}/2026-03-02.md`]: RESULT('2026-03-02', 'No records yet.\n'),
    [`${R}/README.md`]: '## not a run\n',
    [`${R}/sub/_template.md`]: '## not a run\n',
  });
  roots.push(r);
  const out = await listEvals(createConfig({ REPO_ROOT: r }), NOW);
  assert.deepEqual(
    out.problems.map((p) => [p.path, p.reason]),
    [
      [`${R}/2026-02-30.md`, 'bad-filename'],
      [`${R}/2026-03-01.md`, 'bad-h1'],
      [`${R}/2026-03-02.md`, 'no-run-blocks'],
      [`${R}/notes.md`, 'bad-filename'],
    ]
  );
  // bad-h1 keeps its runs, dated by the filename.
  assert.deepEqual(out.evals.map((e) => [e.id, e.runs.map((x) => x.date)]), [['eval-a', ['2026-03-01']]]);
  assert.equal(out.suite.resultFiles, 2);
});

test('suite clock: full-suite line only before the first run; due at 28 days, not 27', async () => {
  const r = await makeRepo({
    [`${C}/a.md`]: CASE('eval-a', 'deterministic', 'A'),
    [`${R}/2026-01-01.md`]: RESULT('2026-01-01', `## eval-a — PASS\n${FIELDS()}`, { full: true }),
    // The line after the first `## ` does not make this a full-suite file.
    [`${R}/2026-01-20.md`]: RESULT('2026-01-20', `## eval-a — PASS\n${FIELDS()}\nRun: full monthly suite\n`),
  });
  roots.push(r);
  const config = createConfig({ REPO_ROOT: r });
  const at27 = await listEvals(config, new Date(2026, 0, 28, 23, 59));
  assert.deepEqual(at27.suite.fullSuiteDates, ['2026-01-01']);
  assert.equal(at27.suite.ageDays, 27);
  assert.equal(at27.suite.due, false);
  const at28 = await listEvals(config, new Date(2026, 0, 29, 0, 1));
  assert.equal(at28.suite.ageDays, 28);
  assert.equal(at28.suite.due, true);
});

test('suite: no full-suite run is due (check 23); case id fallback; malformed heading still clears never-run', async () => {
  const r = await makeRepo({
    [`${C}/a.md`]: CASE('eval-a', 'deterministic', 'A'),
    [`${C}/nested/b-case.md`]: CASE(null, 'judgment', 'B'), // fallback id eval-b-case
    [`${C}/c.md`]: CASE('eval-c', 'mixed', 'C'),
    [`${R}/2026-01-01.md`]: RESULT('2026-01-01', `## eval-a — PASS\n${FIELDS()}\n## eval-c - PASS\n${FIELDS()}`),
  });
  roots.push(r);
  const out = await listEvals(createConfig({ REPO_ROOT: r }), NOW);
  assert.equal(out.suite.neverFullSuite, true);
  assert.equal(out.suite.lastFullSuiteDate, null);
  assert.equal(out.suite.ageDays, null);
  assert.equal(out.suite.due, true);
  assert.deepEqual(out.suite.neverRun, ['eval-b-case']);
  assert.deepEqual(out.suite.withoutCase, []);
  // eval-c heads only a malformed block: listed (it has a case) with no
  // well-formed run, yet ever-run as check 23 counts it — never "never run".
  const c = out.evals.find((e) => e.id === 'eval-c');
  assert.deepEqual(c.runs, []);
  assert.equal(c.everRun, true);
  assert.equal(out.evals.find((e) => e.id === 'eval-b-case').everRun, false);
  assert.equal(out.evals.find((e) => e.id === 'eval-a').everRun, true);
});

test('a duplicate case id keeps the first page and surfaces the other as a problem', async () => {
  const r = await makeRepo({
    [`${C}/a.md`]: CASE('eval-a', 'deterministic', 'A'),
    [`${C}/a-copy.md`]: CASE('eval-a', 'judgment', 'A copy'),
    [`${C}/b.md`]: CASE('eval-b', 'mixed', 'B'),
  });
  roots.push(r);
  const out = await listEvals(createConfig({ REPO_ROOT: r }), NOW);
  assert.equal(out.suite.cases, 2);
  // Path order: a-copy.md sorts before a.md, so it is the case; a.md is surfaced.
  assert.equal(out.evals.find((e) => e.id === 'eval-a').case.path, `${C}/a-copy.md`);
  assert.deepEqual(out.problems, [{ path: `${C}/a.md`, line: null, reason: 'duplicate-case-id' }]);
});

test('symlinked result files are not followed (documented divergence from lint rglob)', async () => {
  const r = await makeRepo({
    'elsewhere/2026-01-01.md': RESULT('2026-01-01', `## eval-a — PASS\n${FIELDS()}`),
    [`${R}/2026-01-02.md`]: RESULT('2026-01-02', `## eval-a — PASS\n${FIELDS()}`),
  });
  roots.push(r);
  await fs.symlink(path.join(r, 'elsewhere/2026-01-01.md'), path.join(r, R, '2026-01-01.md'));
  const out = await listEvals(createConfig({ REPO_ROOT: r }), NOW);
  assert.equal(out.suite.resultFiles, 1);
  assert.deepEqual(out.evals[0].runs.map((x) => x.date), ['2026-01-02']);
});

test('problems capped with an exact count, never carrying file text', async () => {
  const files = {};
  for (let i = 1; i <= 25; i += 1) files[`${R}/bad-${String(i).padStart(2, '0')}.md`] = 'SECRET-BODY\n';
  files[`${R}/2026-01-01.md`] = RESULT('2026-01-01', '## SECRET-HEADING\n');
  const r = await makeRepo(files);
  roots.push(r);
  const out = await listEvals(createConfig({ REPO_ROOT: r }), NOW);
  assert.equal(out.problemCount, 27); // 25 bad-filename + malformed-heading + no-run-blocks
  assert.equal(out.problems.length, EVAL_PROBLEM_LIMIT);
  for (const p of out.problems) assert.deepEqual(Object.keys(p).sort(), ['line', 'path', 'reason']);
  assert.ok(!JSON.stringify(out).includes('SECRET'));
});

test('no evals/ directory → 200 with empty lists', async () => {
  const r = await makeRepo({ 'wiki/index.md': '# Index\n' });
  roots.push(r);
  const res = await request(createApp(createConfig({ REPO_ROOT: r }))).get('/api/evals');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.evals, []);
  assert.equal(res.body.suite.cases, 0);
  assert.equal(res.body.suite.runs, 0);
  assert.equal(res.body.suite.due, false);
  assert.deepEqual(res.body.problems, []);
});

test('GET /api/evals over the fixture; the Workflow registry still lists nothing under results/ or cases/', async () => {
  const app = createApp(createConfig({ REPO_ROOT: root }));
  const res = await request(app).get('/api/evals');
  assert.equal(res.status, 200);
  assert.equal(res.body.suite.runs, 6);
  assert.ok(res.body.evals.every((e) => e.runs.every((r) => ['PASS', 'PARTIAL', 'FAIL'].includes(r.verdict))));

  const wf = await request(app).get('/api/workflows');
  assert.equal(wf.status, 200);
  const paths = wf.body.workflows.map((w) => w.path);
  assert.ok(paths.includes('wiki/workflows/evals.md'));
  assert.ok(!paths.some((p) => p.includes('/results/') || p.includes('/cases/')));
});

test('check:evals is a read-only parity check, never on the executable allowlist (invariant 1)', () => {
  assert.ok(!EXECUTABLE_ALLOWLIST.some((id) => /eval/i.test(id)));
});
