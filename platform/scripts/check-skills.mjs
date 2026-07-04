// check:skills — deterministic skill-registry check against the live repo
// (permanent allowlist). Asserts the registry matches an INDEPENDENT
// directory recount of .claude/skills/*/SKILL.md — every skill aos-*
// prefixed, no phantom (/bw2-update-memory does not exist), and every
// invocation is the /name form (ADR-0001: report exactly what exists).
//
// Usage: REPO_ROOT=<memory repo> node scripts/check-skills.mjs
import fssync from 'node:fs';
import path from 'node:path';
import { createConfig } from '../server/src/config.js';
import { listSkills, SKILLS_ROOT } from '../server/src/skills.js';

const config = createConfig(process.env);

let failed = 0;
const record = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// Independent recount: directories under .claude/skills with a SKILL.md.
const recount = [];
const root = path.join(config.REPO_ROOT, SKILLS_ROOT);
if (fssync.existsSync(root)) {
  for (const entry of fssync.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && fssync.existsSync(path.join(root, entry.name, 'SKILL.md'))) {
      recount.push(entry.name);
    }
  }
}
recount.sort();

const { skills } = await listSkills(config);
const reported = skills.map((s) => s.name).sort();

record(
  'registry matches an independent directory recount',
  JSON.stringify(reported) === JSON.stringify(recount),
  `${reported.length} reported / ${recount.length} on disk`
);

record('no phantom skill', !reported.includes('bw2-update-memory'));

record(
  'every skill is aos-* prefixed (repo standard)',
  reported.length > 0 && reported.every((name) => name.startsWith('aos-')),
  reported.filter((name) => !name.startsWith('aos-')).join(', ') || undefined
);

record(
  'every invocation is the /name form',
  skills.every((s) => s.invocation === `/${s.name}`)
);

console.log(
  failed === 0
    ? `\ncheck:skills PASS (repo: ${config.REPO_ROOT}, ${reported.length} skills)`
    : `\ncheck:skills FAIL — ${failed} case(s) (repo: ${config.REPO_ROOT})`
);
process.exit(failed === 0 ? 0 : 1);
