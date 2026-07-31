// check:skills — deterministic skill-registry check against the live repo
// (permanent allowlist). Asserts the registry matches an INDEPENDENT
// directory recount of .claude/skills/*/SKILL.md — every skill aos-*
// prefixed, frontmatter.name exactly matches its directory, no phantom
// (/bw2-update-memory does not exist), and every invocation is the /name form
// (ADR-0001: report exactly what exists).
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

// Deliberately independent from gray-matter and skills.js parsing. This check
// reads only the initial frontmatter block and its top-level name scalar, so a
// production-parser regression cannot make both sides agree by construction.
function independentDeclaredName(skillPath) {
  const text = fssync.readFileSync(skillPath, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0] !== '---') return { status: 'missing' };

  const closing = lines.indexOf('---', 1);
  if (closing === -1) return { status: 'invalid' };

  const nameLines = lines
    .slice(1, closing)
    .filter((line) => /^name\s*:/.test(line));
  if (nameLines.length === 0) return { status: 'missing' };
  if (nameLines.length !== 1) return { status: 'invalid' };

  let scalar = nameLines[0].replace(/^name\s*:/, '').trim();
  if (!scalar) return { status: 'invalid' };

  if (scalar.startsWith('"')) {
    try {
      const value = JSON.parse(scalar);
      return typeof value === 'string' && value.trim()
        ? { status: 'declared', value }
        : { status: 'invalid' };
    } catch {
      return { status: 'invalid' };
    }
  }

  if (scalar.startsWith("'")) {
    if (!scalar.endsWith("'") || scalar.length < 2) return { status: 'invalid' };
    const value = scalar.slice(1, -1).replace(/''/g, "'");
    return value.trim() ? { status: 'declared', value } : { status: 'invalid' };
  }

  scalar = scalar.replace(/\s+#.*$/, '').trim();
  if (
    !scalar ||
    /^[\[{\]|>!&*]/.test(scalar) ||
    /^(?:null|~|true|false)$/i.test(scalar)
  ) {
    return { status: 'invalid' };
  }
  return { status: 'declared', value: scalar };
}

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

const nameDrift = recount.flatMap((directoryName) => {
  const declared = independentDeclaredName(
    path.join(root, directoryName, 'SKILL.md')
  );
  if (declared.status === 'declared' && declared.value === directoryName) return [];

  const actual =
    declared.status === 'declared'
      ? `found ${JSON.stringify(declared.value)}`
      : `found ${declared.status}`;
  return [
    `${directoryName}: expected ${JSON.stringify(directoryName)}, ${actual}`,
  ];
});

record(
  'every SKILL.md frontmatter.name matches its directory',
  nameDrift.length === 0,
  nameDrift.join('; ') || undefined
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
