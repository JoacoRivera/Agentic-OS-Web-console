import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { EXECUTABLE_ALLOWLIST } from '../src/operations.js';

const app = createApp(createConfig({ REPO_ROOT: '/tmp/fixture-root' }));

const getCatalog = async () => {
  const res = await request(app).get('/api/operations').set('Host', '127.0.0.1:3001');
  assert.equal(res.status, 200);
  return res.body;
};

test('GET /api/operations returns the static catalog with counts', async () => {
  const body = await getCatalog();
  assert.ok(Array.isArray(body.operations) && body.operations.length > 0);
  assert.equal(body.total, body.operations.length);
  assert.equal(body.counts.guided + body.counts.executable, body.total);
});

test('every operation is typed guided or executable — no third kind', async () => {
  const body = await getCatalog();
  for (const op of body.operations) {
    assert.ok(['guided', 'executable'].includes(op.type), `${op.id} has type ${op.type}`);
  }
});

test('every LLM-Skill-backed operation is guided (ADR-0001)', async () => {
  const body = await getCatalog();
  const skillBacked = body.operations.filter((op) => op.skill);
  assert.ok(skillBacked.length > 0, 'catalog references the repo skills');
  for (const op of skillBacked) {
    assert.equal(op.type, 'guided', `${op.id} is backed by /${op.skill} and must be guided`);
  }
});

test('guided operations carry a checklist + command preview, nothing runnable', async () => {
  const body = await getCatalog();
  for (const op of body.operations.filter((o) => o.type === 'guided')) {
    assert.ok(op.checklist.length > 0, `${op.id} has a checklist`);
    assert.ok(typeof op.commandPreview === 'string' && op.commandPreview.length > 0);
    assert.equal(op.executableInPhase, undefined, `${op.id} must not advertise execution`);
  }
});

test('executable entries are exactly the permanent allowlist plus flagged migration gates', async () => {
  const body = await getCatalog();
  assert.deepEqual(body.allowlist, EXECUTABLE_ALLOWLIST);
  const executable = body.operations.filter((op) => op.type === 'executable');
  for (const op of executable) {
    if (!EXECUTABLE_ALLOWLIST.includes(op.id)) {
      assert.equal(op.migrationOnly, true, `${op.id} is outside the allowlist without migrationOnly`);
    }
    assert.equal(op.executableInPhase, 3);
  }
  // check:hud-parity was retired by the HUD-deprecation sign-off (ADR-0002,
  // 2026-07-04): gone from the catalog, never in the permanent allowlist.
  assert.equal(executable.find((op) => op.id === 'check:hud-parity'), undefined);
  assert.ok(!EXECUTABLE_ALLOWLIST.includes('check:hud-parity'));
});

test('no phantom skill: catalog skills are among the five real ones', async () => {
  const REAL = ['ingest', 'query-memory', 'wiki-lint', 'capture-approved-example', 'promote-draft-memory'];
  const body = await getCatalog();
  for (const op of body.operations) {
    if (op.skill) assert.ok(REAL.includes(op.skill), `${op.skill} is not a real repo skill`);
  }
});

test('POST /api/operations/:id/run returns 501 in P1 (ADR-0001)', async () => {
  const res = await request(app)
    .post('/api/operations/check-paths/run')
    .set('Host', '127.0.0.1:3001');
  assert.equal(res.status, 501);
  assert.equal(res.body.error, 'not-implemented');
});

test('POST /api/operations/:id/dry-run returns 501 in P1 (ADR-0001)', async () => {
  const res = await request(app)
    .post('/api/operations/anything/dry-run')
    .set('Host', '127.0.0.1:3001');
  assert.equal(res.status, 501);
});
