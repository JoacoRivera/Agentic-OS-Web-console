// check:memory-stats-parity — TERMINAL-ONLY comparison of /api/metrics.flow
// with the memory repo's own `scripts/memory-stats.py --format json`
// (ADR-0003 amendment 2026-11-14). It runs memory-repo Python, so it is NOT
// in the Phase-3 executable allowlist, the Operations catalog or `verify`
// (ADR-0001): the console never executes it. The permanent, allowlisted check
// is the independent JS recount in check:metrics-groundtruth.
//
// It boots the real server on an ephemeral port, fetches /api/metrics, runs
// `python3 <REPO_ROOT>/scripts/memory-stats.py --root <REPO_ROOT> --format json
// --today <flow.today>` (argv array, no shell) and compares block by block.
// Prints counts and dates only — never the per-month capture paths.
// Skips (exit 0, reason printed) when the script is absent under REPO_ROOT or
// python3 is not installed.
//
// Usage: REPO_ROOT=<memory repo> node scripts/check-memory-stats-parity.mjs
import { spawn } from 'node:child_process';
import fssync from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// memory-stats.py LATENCY_BUCKETS order (its JSON sorts the keys).
const BUCKET_LABELS = ['same day', '1-3d', '4-7d', '8-30d', '>30d'];
// memory-stats.py DUE_DAYS = wiki_log.MAINTENANCE_CADENCE_DAYS; not in its JSON.
const CADENCE_DAYS = 7;

const summary = (s) =>
  s && s.n
    ? { n: s.n, min: s.min, median: s.median, p90: s.p90, max: s.max }
    : { n: 0, min: null, median: null, p90: null, max: null };

/**
 * `memory-stats.py --format json` output → the `/api/metrics.flow` shape.
 * `capture_paths` is dropped: flow carries counts only.
 */
export function fromMemoryStats(py) {
  const buckets = py.latency?.buckets ?? {};
  const extra = Object.keys(buckets).filter((label) => !BUCKET_LABELS.includes(label));
  const m = py.maintenance ?? {};
  const queue = (b) => ({ count: b?.count, unlineaged: b?.unlineaged, ages: summary(b?.ages) });
  return {
    today: py.today,
    captures: { total: py.captures?.total, unlineaged: py.captures?.unlineaged },
    months: Object.keys(py.months ?? {})
      .sort()
      .map((month) => ({
        month,
        captures: py.months[month].captures,
        ingestEntries: py.months[month].ingest_entries,
      })),
    latency: {
      ...summary(py.latency),
      // Unknown labels are kept so a changed bucket set shows as a mismatch.
      buckets: [...BUCKET_LABELS, ...extra].map((label) => ({ label, count: buckets[label] ?? null })),
      noDatedIngestEntry: py.latency?.no_dated_ingest_entry,
      ingestBeforeIntake: py.latency?.ingest_before_intake,
    },
    passes: {
      days: m.passes,
      newest: m.newest ?? null,
      openGapDays: m.open_gap_days ?? null,
      gaps: summary(m.gaps),
      gapsOverCadence: m.gaps_over_cadence,
      cadenceDays: CADENCE_DAYS,
      longestGap: m.longest_gap
        ? { from: m.longest_gap.from, to: m.longest_gap.to, days: m.longest_gap.days }
        : null,
    },
    queue: { draft: queue(py.backlog?.draft), onHold: queue(py.backlog?.['on-hold']) },
  };
}

/** JSON with object keys sorted, so key order never decides a comparison. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

// ---------- terminal run ----------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function getJson(port, reqPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: reqPath }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          if (res.statusCode !== 200) reject(new Error(`${reqPath} → ${res.statusCode}`));
          else resolve(JSON.parse(body));
        });
      })
      .on('error', reject);
  });
}

/** `{code, stdout, stderr}`, or `{missing: true}` when python3 is not installed. */
function runPython(script, repoRoot, today) {
  return new Promise((resolve) => {
    const child = spawn(
      'python3',
      [script, '--root', repoRoot, '--format', 'json', '--today', today],
      // No __pycache__ written into the memory repo: the run stays read-only.
      { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => resolve(err.code === 'ENOENT' ? { missing: true } : { code: -1, stdout, stderr: err.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const platformDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const serverEntry = path.join(platformDir, 'server', 'src', 'index.js');
  const repoRoot = process.env.REPO_ROOT
    ? path.resolve(process.env.REPO_ROOT.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'))
    : path.resolve(platformDir, '..');
  const script = path.join(repoRoot, 'scripts', 'memory-stats.py');

  if (!fssync.existsSync(script)) {
    console.log(`– skipped: scripts/memory-stats.py is absent under REPO_ROOT (${repoRoot})`);
    return 0;
  }

  const port = await freePort();
  const child = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', REPO_ROOT: repoRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  let failed = 0;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server boot timeout; stderr: ${stderr}`)), 8000);
      child.stdout.on('data', () => {
        if (stdout.includes('listening on')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', (code) => reject(new Error(`server exited early (${code}); stderr: ${stderr}`)));
    });

    const { flow } = await getJson(port, '/api/metrics');
    if (!flow) throw new Error('/api/metrics has no flow block');
    // The API's own day, so a run across midnight compares like with like.
    const py = await runPython(script, repoRoot, flow.today);
    if (py.missing) {
      console.log('– skipped: python3 is not installed');
      return 0;
    }
    if (py.code !== 0) {
      throw new Error(`memory-stats.py exited ${py.code}: ${py.stderr.trim().split('\n').at(-1) ?? ''}`);
    }
    const want = fromMemoryStats(JSON.parse(py.stdout));
    for (const key of ['today', 'captures', 'months', 'latency', 'passes', 'queue']) {
      const got = canonical(flow[key]);
      const expected = canonical(want[key]);
      const ok = got === expected;
      if (!ok) failed++;
      console.log(`${ok ? '✔' : '✖'} flow.${key}${ok ? '' : `\n    console:         ${got}\n    memory-stats.py: ${expected}`}`);
    }
  } catch (err) {
    failed++;
    console.error(`✖ ${err.message}`);
  } finally {
    child.kill('SIGTERM');
  }
  console.log(
    failed === 0
      ? `\ncheck:memory-stats-parity PASS (repo: ${repoRoot})`
      : `\ncheck:memory-stats-parity FAIL — ${failed} mismatch(es) (repo: ${repoRoot})`
  );
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(await main());
}
