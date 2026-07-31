import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';

// Fixture repo with five of the real aos-* Skills (ADR-0001): the registry
// must report what the directory scan finds — no more, no less, no phantom.
// Skill names follow the repo standard: every skill is aos-*-prefixed.
let root;

const FIVE = [
  'aos-capture-approved-example',
  'aos-ingest',
  'aos-promote-draft-memory',
  'aos-query-memory',
  'aos-wiki-lint',
];

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-fixture-'));
  const write = async (rel, text) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  };

  // Frontmatter description + a mention of a real workflow (guess target).
  await write(
    '.claude/skills/aos-ingest/SKILL.md',
    '---\nname: aos-ingest\ndescription: Ingest raw sources into the wiki.\n---\n\n# Ingest\n\nFollow wiki/workflows/manual-operations.md.\n'
  );
  // No frontmatter at all → description falls back to the first body line.
  await write(
    '.claude/skills/aos-query-memory/SKILL.md',
    '# Query Memory\n\nRead-only recall of the wiki before doing work.\n'
  );
  await write(
    '.claude/skills/aos-wiki-lint/SKILL.md',
    '---\nname: wiki-lint\ndescription: Check wiki health.\n---\n\n# Wiki Lint\n'
  );
  await write(
    '.claude/skills/aos-capture-approved-example/SKILL.md',
    '---\nname: []\ndescription: Capture an approved result into raw/.\n---\n\n# Capture\n'
  );
  await write(
    '.claude/skills/aos-promote-draft-memory/SKILL.md',
    '---\nname: "aos-promote-draft-memory "\ndescription: Triage a draft capture.\n---\n\n# Promote\n'
  );

  // Non-skills that must NOT appear: a directory without SKILL.md, a stray
  // file in the skills root, and a nested asset inside a real skill.
  await write('.claude/skills/not-a-skill/README.md', '# Not a skill\n');
  await write('.claude/skills/notes.md', 'stray file\n');
  await write('.claude/skills/aos-ingest/examples/sample.md', '# Sample\n');

  // A workflow for the related-workflow guess; its examples/ stays excluded.
  await write(
    'wiki/workflows/manual-operations.md',
    '---\nworkflow_kind: runbook\n---\n\n# Manual Operations\n\n1. Step.\n\n## Verification\nRun checks.\n'
  );
  await write('wiki/index.md', '# Index\n\n- [manual-operations](workflows/manual-operations.md)\n');
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const app = () => createApp(createConfig({ REPO_ROOT: root }));
const get = (url) => request(app()).get(url).set('Host', '127.0.0.1:3001');

test('GET /api/skills returns exactly the fixture five aos-* Skills — no phantom', async () => {
  const res = await get('/api/skills');
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 5);
  assert.deepEqual(
    res.body.skills.map((s) => s.name),
    FIVE
  );
  // The directory scan is the only source: no hardcoded phantom survives.
  assert.ok(!res.body.skills.some((s) => s.name === 'bw2-update-memory'));
  assert.ok(!res.body.skills.some((s) => s.name === 'not-a-skill'));
});

test('each entry carries description, path, mtime, invocation, related workflow', async () => {
  const res = await get('/api/skills');
  for (const s of res.body.skills) {
    assert.equal(s.path, `.claude/skills/${s.name}/SKILL.md`);
    assert.equal(s.absolutePath, path.join(root, s.path));
    assert.equal(s.invocation, `/${s.name}`);
    assert.match(s.mtime, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof s.description, 'string');
  }
});

test('description prefers frontmatter, falls back to the first body line', async () => {
  const res = await get('/api/skills');
  const byName = Object.fromEntries(res.body.skills.map((s) => [s.name, s]));
  assert.equal(byName['aos-ingest'].description, 'Ingest raw sources into the wiki.');
  assert.equal(
    byName['aos-query-memory'].description,
    'Read-only recall of the wiki before doing work.'
  );
});

test('directory name stays canonical and frontmatter name drift is diagnosed', async () => {
  const res = await get('/api/skills');
  const byName = Object.fromEntries(res.body.skills.map((s) => [s.name, s]));

  assert.equal(byName['aos-ingest'].declaredName, 'aos-ingest');
  assert.equal(byName['aos-ingest'].nameDiagnostic, null);

  const drift = byName['aos-wiki-lint'];
  assert.equal(drift.name, 'aos-wiki-lint');
  assert.equal(drift.invocation, '/aos-wiki-lint');
  assert.equal(drift.declaredName, 'wiki-lint');
  assert.deepEqual(drift.nameDiagnostic, {
    code: 'frontmatter-name-mismatch',
    expected: 'aos-wiki-lint',
  });

  const whitespaceDrift = byName['aos-promote-draft-memory'];
  assert.equal(whitespaceDrift.declaredName, 'aos-promote-draft-memory ');
  assert.equal(whitespaceDrift.nameDiagnostic?.code, 'frontmatter-name-mismatch');
});

test('required frontmatter name reports missing and invalid values without exposing them', async () => {
  const res = await get('/api/skills');
  const byName = Object.fromEntries(res.body.skills.map((s) => [s.name, s]));

  assert.equal(byName['aos-query-memory'].declaredName, null);
  assert.deepEqual(byName['aos-query-memory'].nameDiagnostic, {
    code: 'missing-frontmatter-name',
    expected: 'aos-query-memory',
  });

  assert.equal(byName['aos-capture-approved-example'].declaredName, null);
  assert.deepEqual(byName['aos-capture-approved-example'].nameDiagnostic, {
    code: 'invalid-frontmatter-name',
    expected: 'aos-capture-approved-example',
  });
});

test('related workflow is a guess from mentions — null when nothing matches', async () => {
  const res = await get('/api/skills');
  const byName = Object.fromEntries(res.body.skills.map((s) => [s.name, s]));
  assert.equal(byName['aos-ingest'].relatedWorkflow, 'wiki/workflows/manual-operations.md');
  assert.equal(byName['aos-wiki-lint'].relatedWorkflow, null);
});

test('a repo without a skills root yields an empty registry, not an error', async () => {
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-bare-'));
  try {
    const res = await request(createApp(createConfig({ REPO_ROOT: bare })))
      .get('/api/skills')
      .set('Host', '127.0.0.1:3001');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.skills, []);
    assert.equal(res.body.total, 0);
  } finally {
    await fs.rm(bare, { recursive: true, force: true });
  }
});
