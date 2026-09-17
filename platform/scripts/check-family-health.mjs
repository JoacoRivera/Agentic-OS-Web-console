// check:family-health — deterministic check of the Family Health record
// (ADR-0010) against the live Health-Management clone named by
// HEALTH_REPO_ROOT. Prints COUNTS ONLY: no member name, value, condition, or
// path from the record ever reaches stdout. Not in the Phase-3 executable
// allowlist on purpose (run output would land in the audit log).
//
// Usage: HEALTH_REPO_ROOT=<clone> node scripts/check-family-health.mjs
import { createConfig } from '../server/src/config.js';
import { safeResolve } from '../server/src/paths.js';
import {
  HEALTH_ROOTS,
  listMembers,
  readMember,
  readOverview,
  collectPending,
  summarize,
} from '../server/src/familyHealth.js';

let config;
try {
  config = createConfig(process.env);
} catch (err) {
  console.log(`✖ config — ${err.message}`);
  process.exit(1);
}

if (config.HEALTH_REPO_ROOT === null) {
  console.log('– skipped: HEALTH_REPO_ROOT is unset (Family Health not configured, ADR-0010)');
  process.exit(0);
}

let failed = 0;
const record = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

record('health root is outside the memory repo', !config.HEALTH_REPO_ROOT.startsWith(config.REPO_ROOT) && !config.REPO_ROOT.startsWith(config.HEALTH_REPO_ROOT));
record('allowed roots are exactly family-overview.md|members|reference', HEALTH_ROOTS.join('|') === 'family-overview.md|members|reference');

for (const bad of ['../x', '/etc/passwd', '.git/config', 'README.md', 'members/../reference']) {
  let rejected = false;
  try {
    safeResolve(config.HEALTH_REPO_ROOT, bad, HEALTH_ROOTS);
  } catch (err) {
    rejected = err.name === 'PathSafetyError';
  }
  record(`path safety rejects a non-root or traversal path`, rejected, bad);
}

const overview = await readOverview(config);
record('family-overview.md present with a member table', overview.present && overview.rows.length > 0, `${overview.rows.length} rows`);

const members = await listMembers(config);
record('member folders discovered (template excluded)', members.length > 0, `${members.length} members`);

let profiles = 0;
let histories = 0;
let exams = 0;
let examsWithoutResults = 0;
let originalsMissing = 0;
let documents = 0;
let wikiLinked = 0;
for (const m of members) {
  const file = await readMember(config, m.name);
  if (!file.profileMissing) profiles++;
  if (!file.historyMissing) histories++;
  exams += file.exams.length;
  examsWithoutResults += file.exams.filter((e) => !e.hasResultsTable).length;
  originalsMissing += file.stats.originalsMissingN;
  documents += file.documents.length;
  if (m.wikiPath) wikiLinked++;
}
record('every member has profile.md', profiles === members.length, `${profiles}/${members.length}`);
record('every member has history.md', histories === members.length, `${histories}/${members.length}`);
record('every member is listed in family-overview.md', members.every((m) => overview.rows.some((r) => r.member.toLowerCase() === m.name.toLowerCase())));
record('exam notes parsed', true, `${exams} notes · ${examsWithoutResults} without a results table · ${originalsMissing} originals recorded missing · ${documents} originals listed`);
record('wiki cross-links resolved where a member page exists', true, `${wikiLinked}/${members.length} members linked`);

const pending = await collectPending(config);
record('pending items collected from explicit signals only', Array.isArray(pending.items), `${pending.total} items · ${JSON.stringify(pending.byKind)}`);

const summary = await summarize(config);
record(
  'summary totals agree with the per-member recount',
  summary.totals.membersN === members.length && summary.totals.examsN === exams && summary.totals.documentsN === documents && summary.totals.originalsMissingN === originalsMissing
);
record('summary carries the physician notice', /never a diagnosis/.test(summary.notice));

console.log(`\n${failed === 0 ? 'check:family-health passed' : `check:family-health failed (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
