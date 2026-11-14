// check:session-status — parity of the console's Session Status
// (server/src/sessionStatus.js) with the memory repo's own
// `scripts/aos_status.py` on the live REPO_ROOT (invariant 8). It computes the
// status in-process and runs the script for the same day, then compares the
// maintenance / captures / on-hold / git lines string for string and the
// githook and host notes against the script's `setup:` line.
//
// Terminal-only, on purpose: it is NOT in the Phase-3 executable allowlist
// and NOT in CI, because it runs memory-repo Python (ADR-0001: the console
// executes only its own deterministic checks). Exits 0 with "– skipped" when
// python3 or the script is missing; exits 1 on any mismatch, printing both.
//
// Usage: REPO_ROOT=<memory repo> node scripts/check-session-status.mjs
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createConfig } from '../server/src/config.js';
import { computeSessionStatus, githookNote, hostNote, localDay } from '../server/src/sessionStatus.js';

let config;
try {
  config = createConfig(process.env);
} catch (err) {
  console.log(`✖ config — ${err.message}`);
  process.exit(1);
}

const script = path.join(config.REPO_ROOT, 'scripts', 'aos_status.py');
if (!fs.existsSync(script)) {
  console.log(`– skipped: ${path.relative(config.REPO_ROOT, script)} not found under REPO_ROOT`);
  process.exit(0);
}

const now = new Date();
const today = localDay(now);

function runScript() {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      ['-B', script, '--today', today, '--root', config.REPO_ROOT],
      {
        cwd: config.REPO_ROOT,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        shell: false,
        timeout: 20000,
        encoding: 'utf8',
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
  });
}

let output;
try {
  output = await runScript();
} catch (err) {
  if (err.code === 'ENOENT') {
    console.log('– skipped: python3 is not installed');
    process.exit(0);
  }
  console.log(`✖ running aos_status.py — ${err.message}`);
  process.exit(1);
}

const ours = await computeSessionStatus(config, { now });

const LABELS = ['maintenance pass', 'captures', 'on hold', 'git', 'setup'];
const byLabel = (lines) =>
  Object.fromEntries(LABELS.map((label) => [label, lines.find((l) => l.startsWith(`${label}: `)) ?? null]));
const theirs = byLabel(output.split('\n'));
const mine = byLabel(ours.lines);

let failed = 0;
const record = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `\n    console: ${detail[0]}\n    script:  ${detail[1]}` : ''}`);
};
// A degraded line (the script lacking PyYAML, either side out of time) is an
// environment fact, not a rule drift: report it and move on.
const DEGRADED = /^[a-z ]+: (unavailable \(|skipped \(time budget\))/;
const ourTimeout = (line) => /^[a-z ]+: skipped \(time budget\)$/.test(line ?? '');

for (const label of ['maintenance pass', 'captures', 'on hold', 'git']) {
  const [a, b] = [mine[label], theirs[label]];
  if (DEGRADED.test(b ?? '') || ourTimeout(a)) {
    console.log(`– ${label}: skipped (degraded)\n    console: ${a}\n    script:  ${b}`);
    continue;
  }
  if (a === null && b === null) {
    console.log(`✔ ${label}: absent on both sides`);
    continue;
  }
  record(`${label} line matches aos_status.py`, a === b, a === b ? '' : [a, b]);
}

// setup: "setup: ok (a, b, …)" or "setup: note; note — ok: a, b".
const setup = theirs.setup ?? '';
let notes = [];
let oks = [];
const allOk = setup.match(/^setup: ok \((.*)\)$/);
if (allOk) oks = allOk[1].split(', ');
else if (setup.startsWith('setup: ')) {
  const [n, o] = setup.slice('setup: '.length).split(' — ok: ');
  notes = n.split('; ');
  oks = o ? o.split(', ') : [];
}
const setupAgrees = (label, note) => (note === null ? oks.includes(label) : notes.includes(note));
const hook = githookNote(ours.setup.githook);
const host = hostNote(ours.setup.host);
record(
  'setup githook agrees with aos_status.py',
  setupAgrees('githook', hook),
  setupAgrees('githook', hook) ? '' : [hook ?? 'githook ok', setup]
);
record(
  'setup host row agrees with aos_status.py',
  setupAgrees(`host ${ours.setup.host.name}`, host),
  setupAgrees(`host ${ours.setup.host.name}`, host) ? '' : [host ?? `host ${ours.setup.host.name} ok`, setup]
);

process.exit(failed ? 1 : 0);
