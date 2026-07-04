import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';

// Fixture repo with exactly the five real Skills (ADR-0001): the registry
// must report what the directory scan finds — no more, no less, no phantom.
let root;

const FIVE = [
  'capture-approved-example',
  'ingest',
  'promote-draft-memory',
  'query-memory',
  'wiki-lint',
];

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-fixture-'));
  const write = async (rel, text) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  };

  // Frontmatter description + a mention of a real workflow (guess target).
  await write(
    '.claude/skills/ingest/SKILL.md',
    '---\nname: ingest\ndescription: Ingest raw sources into the wiki.\n---\n\n# Ingest\n\nFollow wiki/workflows/manual-operations.md.\n'
  );
  // No frontmatter at all → description falls back to the first body line.
  await write(
    '.claude/skills/query-memory/SKILL.md',
    '# Query Memory\n\nRead-only recall of the wiki before doing work.\n'
  );
  await write(
    '.claude/skills/wiki-lint/SKILL.md',
    '---\ndescription: Check wiki health.\n---\n\n# Wiki Lint\n'
  );
  await write(
    '.claude/skills/capture-approved-example/SKILL.md',
    '---\ndescription: Capture an approved result into raw/.\n---\n\n# Capture\n'
  );
  await write(
    '.claude/skills/promote-draft-memory/SKILL.md',
    '---\ndescription: Triage a draft capture.\n---\n\n# Promote\n'
  );

  // Non-skills that must NOT appear: a directory without SKILL.md, a stray
  // file in the skills root, and a nested asset inside a real skill.
  await write('.claude/skills/not-a-skill/README.md', '# Not a skill\n');
  await write('.claude/skills/notes.md', 'stray file\n');
  await write('.claude/skills/ingest/examples/sample.md', '# Sample\n');

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

test('GET /api/skills returns exactly the five real Skills — no phantom', async () => {
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
  assert.equal(byName['ingest'].description, 'Ingest raw sources into the wiki.');
  assert.equal(
    byName['query-memory'].description,
    'Read-only recall of the wiki before doing work.'
  );
});

test('related workflow is a guess from mentions — null when nothing matches', async () => {
  const res = await get('/api/skills');
  const byName = Object.fromEntries(res.body.skills.map((s) => [s.name, s]));
  assert.equal(byName['ingest'].relatedWorkflow, 'wiki/workflows/manual-operations.md');
  assert.equal(byName['wiki-lint'].relatedWorkflow, null);
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
