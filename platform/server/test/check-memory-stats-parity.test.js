import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, fromMemoryStats } from '../../scripts/check-memory-stats-parity.mjs';

const platformDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checkScript = path.join(platformDir, 'scripts', 'check-memory-stats-parity.mjs');

// A synthetic `memory-stats.py --format json` document (sorted keys, as it prints).
const recorded = {
  backlog: {
    draft: { ages: { max: 12, median: 7.5, min: 3, n: 2, p90: 12 }, count: 3, unlineaged: 1 },
    'on-hold': { ages: { n: 0 }, count: 0, unlineaged: 0 },
  },
  captures: { total: 9, unlineaged: 2 },
  latency: {
    buckets: { '1-3d': 1, '4-7d': 0, '8-30d': 1, '>30d': 0, 'same day': 2 },
    ingest_before_intake: 1,
    max: 9,
    median: 0.5,
    min: 0,
    n: 4,
    no_dated_ingest_entry: 1,
    p90: 9,
  },
  maintenance: {
    gaps: { max: 37, median: 23.5, min: 10, n: 2, p90: 37 },
    gaps_over_cadence: 2,
    longest_gap: { days: 37, from: '2026-02-01', to: '2026-03-10' },
    newest: '2026-03-20',
    open_gap_days: 5,
    passes: 3,
  },
  months: {
    '2026-03': { capture_paths: ['raw/demo/examples/b.md'], captures: 1, ingest_entries: 2 },
    '2026-02': { capture_paths: ['raw/demo/examples/a.md'], captures: 1, ingest_entries: 1 },
  },
  today: '2026-03-25',
};

test('fromMemoryStats maps the Python JSON onto the flow shape', () => {
  assert.deepEqual(fromMemoryStats(recorded), {
    today: '2026-03-25',
    captures: { total: 9, unlineaged: 2 },
    months: [
      { month: '2026-02', captures: 1, ingestEntries: 1 },
      { month: '2026-03', captures: 1, ingestEntries: 2 },
    ],
    latency: {
      n: 4, min: 0, median: 0.5, p90: 9, max: 9,
      buckets: [
        { label: 'same day', count: 2 },
        { label: '1-3d', count: 1 },
        { label: '4-7d', count: 0 },
        { label: '8-30d', count: 1 },
        { label: '>30d', count: 0 },
      ],
      noDatedIngestEntry: 1,
      ingestBeforeIntake: 1,
    },
    passes: {
      days: 3,
      newest: '2026-03-20',
      openGapDays: 5,
      gaps: { n: 2, min: 10, median: 23.5, p90: 37, max: 37 },
      gapsOverCadence: 2,
      cadenceDays: 7,
      longestGap: { from: '2026-02-01', to: '2026-03-10', days: 37 },
    },
    queue: {
      draft: { count: 3, unlineaged: 1, ages: { n: 2, min: 3, median: 7.5, p90: 12, max: 12 } },
      // `{n: 0}` → absent figures, never zeros.
      onHold: { count: 0, unlineaged: 0, ages: { n: 0, min: null, median: null, p90: null, max: null } },
    },
  });
  assert.equal(JSON.stringify(fromMemoryStats(recorded)).includes('raw/'), false, 'capture_paths dropped');
});

test('fromMemoryStats: no passes and no latency map to nulls; an unknown bucket is kept', () => {
  const flow = fromMemoryStats({
    ...recorded,
    latency: { n: 0, buckets: { 'same day': 0, '1-3d': 0, '4-7d': 0, '8-30d': 0, '>30d': 0, '>90d': 0 }, no_dated_ingest_entry: 0, ingest_before_intake: 0 },
    maintenance: { passes: 0, newest: null, open_gap_days: null, gaps: { n: 0 }, gaps_over_cadence: 0, longest_gap: null },
  });
  assert.equal(flow.latency.median, null);
  assert.equal(flow.latency.buckets.at(-1).label, '>90d');
  assert.equal(flow.passes.longestGap, null);
  assert.equal(flow.passes.newest, null);
  assert.equal(flow.passes.gaps.max, null);
});

test('canonical ignores key order but not values', () => {
  assert.equal(canonical({ a: 1, b: [{ y: 2, x: 1 }] }), canonical({ b: [{ x: 1, y: 2 }], a: 1 }));
  assert.notEqual(canonical({ a: 1 }), canonical({ a: 2 }));
});

test('the check skips with exit 0 when scripts/memory-stats.py is absent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-stats-parity-skip-'));
  try {
    const { code, output } = await new Promise((resolve) => {
      const child = spawn(process.execPath, [checkScript], {
        cwd: platformDir,
        env: { ...process.env, REPO_ROOT: root },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('close', (exitCode) => resolve({ code: exitCode, output: out }));
    });
    assert.equal(code, 0);
    assert.match(output, /skipped: scripts\/memory-stats\.py is absent/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the parity check stays out of the executable allowlist (ADR-0001)', async () => {
  const { EXECUTABLE_ALLOWLIST } = await import('../src/operations.js');
  assert.ok(EXECUTABLE_ALLOWLIST.length > 0);
  assert.equal(EXECUTABLE_ALLOWLIST.some((id) => id.includes('memory-stats')), false);
});
