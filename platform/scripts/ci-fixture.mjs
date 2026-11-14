// ci:fixture — run the live-repo checks and the boot smoke against the
// committed synthetic memory repo (server/test/fixtures/memory-repo), the way
// CI does. One command reproduces the CI step locally.
//
// Not a `check:*` script and not on the executable allowlist (ADR-0001): it is
// a CI harness around the allowlisted checks, never an Operation.
//
// Each child runs with `process.execPath` directly — no `--env-file`, so a
// developer's platform/.env cannot leak in — and with every optional external
// source cleared: raw content gated (ADR-0005), no proxy pair, no Family
// Health root (ADR-0010), no Firefly (ADR-0011). All checks run even after a
// failure; the exit code is non-zero if any failed.
//
// Usage: node scripts/ci-fixture.mjs   (or: npm run ci:fixture)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const platformDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(platformDir, 'server', 'test', 'fixtures', 'memory-repo');

// One entry per line, in run order; an item adding a JS-only check adds a line.
const CHECKS = [
  'scripts/check-docs.mjs',
  'scripts/check-workflows.mjs',
  'scripts/check-skills.mjs',
  'scripts/check-metrics-groundtruth.mjs',
  'scripts/verify.mjs',
];

const CLEARED = [
  'PROXY_HOSTNAME',
  'PROXY_SECRET',
  'LOCAL_HOSTNAME',
  'HEALTH_REPO_ROOT',
  'FAMILY_HEALTH_ALLOW_PROXY',
  'FIREFLY_URL',
  'FIREFLY_TOKEN',
  'FIREFLY_PUBLIC_URL',
  'FINANCE_ALLOW_PROXY',
];
const env = { ...process.env, REPO_ROOT: FIXTURE, EXPOSE_RAW_CONTENT: 'false' };
for (const key of CLEARED) delete env[key];

function run(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd: platformDir, env, stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`✖ ${script}: ${err.message}`);
      resolve(1);
    });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

const results = [];
for (const script of CHECKS) {
  console.log(`\n=== ${script} (REPO_ROOT=${path.relative(platformDir, FIXTURE)})`);
  results.push({ script, code: await run(script) });
}

const failed = results.filter((r) => r.code !== 0);
console.log('\n=== ci:fixture summary');
for (const { script, code } of results) console.log(`${code === 0 ? '✔' : '✖'} ${script}${code === 0 ? '' : ` (exit ${code})`}`);
console.log(
  failed.length === 0
    ? `ci:fixture PASS — ${results.length}/${results.length} (repo: ${FIXTURE})`
    : `ci:fixture FAIL — ${failed.length} of ${results.length} failed (repo: ${FIXTURE})`
);
process.exit(failed.length === 0 ? 0 : 1);
