// check:paths — deterministic path-safety check (permanent allowlist).
// Asserts paths.safeResolve rejects traversal, absolute paths, NUL bytes,
// and out-of-root reads, and accepts the documented allowed roots. Pure
// in-process table test — no server boot, no filesystem reads.
import path from 'node:path';
import { safeResolve, PathSafetyError, ALLOWED_ROOTS } from '../server/src/paths.js';

const repoRoot = '/repo-root-fixture';

const MUST_REJECT = [
  '../etc/passwd',
  'wiki/../../etc/passwd',
  'wiki/..',
  '..',
  '/etc/passwd',
  'C:\\Windows\\system32',
  'c:/Windows/system32',
  '\\\\share\\secret',
  'wiki\\..\\..\\etc',
  'wiki/a\0b.md',
  '',
  'secrets/keys.md', // inside the repo, outside the allowed roots
  '.claude/settings.json', // sibling of an allowed root, not inside it
  'AGENTS.md.bak', // prefix of an allowed root is not the root
  'dashboards',
  'dashboards/aos-hud.js', // retired root is outside the active console surface
];

const MUST_ACCEPT = [
  'AGENTS.md',
  'wiki/index.md',
  'wiki/workflows/task-modes.md',
  'raw/projects/x.md',
  'templates/page.md',
  '.claude/skills/aos-ingest/SKILL.md',
];

let failed = 0;
const record = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

for (const rel of MUST_REJECT) {
  try {
    const abs = safeResolve(repoRoot, rel);
    record(`rejects ${JSON.stringify(rel)}`, false, `resolved to ${abs}`);
  } catch (err) {
    record(`rejects ${JSON.stringify(rel)}`, err instanceof PathSafetyError, err.message);
  }
}

for (const rel of MUST_ACCEPT) {
  try {
    const abs = safeResolve(repoRoot, rel);
    const inside = abs.startsWith(path.resolve(repoRoot) + path.sep);
    record(`accepts ${JSON.stringify(rel)} inside the root`, inside, abs);
  } catch (err) {
    record(`accepts ${JSON.stringify(rel)} inside the root`, false, err.message);
  }
}

record(
  'every allowed root itself resolves',
  ALLOWED_ROOTS.every((root) => {
    try {
      safeResolve(repoRoot, root);
      return true;
    } catch {
      return false;
    }
  })
);

console.log(failed === 0 ? '\ncheck:paths PASS' : `\ncheck:paths FAIL — ${failed} case(s)`);
process.exit(failed === 0 ? 0 : 1);
