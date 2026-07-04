// check:workflows — deterministic registry check against the live repo
// (permanent allowlist). Asserts the ADR-0006/0007 registry rules with an
// INDEPENDENT filesystem recount of wiki/workflows: inclusion (exclude
// **/{examples,cases,results}/**), a closed status vocabulary, no defaulted
// kind (un-annotated → unclassified unless a higher-precedence defect), and
// a consistent summary roll-up.
//
// Usage: REPO_ROOT=<memory repo> node scripts/check-workflows.mjs
import fssync from 'node:fs';
import path from 'node:path';
import { createConfig } from '../server/src/config.js';
import { listWorkflows, WORKFLOW_KINDS, STATUS_LABELS } from '../server/src/workflows.js';

const config = createConfig(process.env);

let failed = 0;
const record = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// Independent recount, from the documented rule (not the server's scanner).
const EXCLUDED = new Set(['examples', 'cases', 'results']);
function recount(rel) {
  const out = [];
  const abs = path.join(config.REPO_ROOT, rel);
  if (!fssync.existsSync(abs)) return out;
  for (const entry of fssync.readdirSync(abs, { withFileTypes: true })) {
    const p = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== '.git' && !EXCLUDED.has(entry.name)) out.push(...recount(p));
    } else if (entry.name.endsWith('.md')) {
      out.push(p);
    }
  }
  return out;
}
const expected = recount('wiki/workflows').sort();

const { workflows, summary } = await listWorkflows(config);
const reported = workflows.map((w) => w.path).sort();

record(
  'registry matches an independent recount (excluding examples/cases/results)',
  JSON.stringify(reported) === JSON.stringify(expected),
  `${reported.length} reported / ${expected.length} on disk`
);

record(
  'no excluded data path carries a status verdict',
  reported.every((p) => !p.split('/').some((seg) => EXCLUDED.has(seg)))
);

record(
  'every status is in the closed vocabulary',
  workflows.every((w) => w.status in STATUS_LABELS)
);

record(
  'every kind is null or in the closed workflow_kind vocabulary (no default kind, ADR-0007)',
  workflows.every((w) => w.kind === null || w.kind in WORKFLOW_KINDS)
);

// Precedence: an un-annotated workflow may only show missing-links or
// needs-review above unclassified — never stale or ok (that would be an
// assumed default kind).
record(
  'un-annotated workflows never resolve below unclassified',
  workflows
    .filter((w) => w.kind === null)
    .every((w) => ['missing-links', 'needs-review', 'unclassified'].includes(w.status))
);

record(
  'classified workflows are never unclassified',
  workflows.filter((w) => w.kind !== null).every((w) => w.status !== 'unclassified')
);

record(
  'summary roll-up is consistent',
  summary.total === workflows.length &&
    Object.keys(STATUS_LABELS).every(
      (id) => summary[id] === workflows.filter((w) => w.status === id).length
    )
);

console.log(
  failed === 0
    ? `\ncheck:workflows PASS (repo: ${config.REPO_ROOT}, ${workflows.length} workflows)`
    : `\ncheck:workflows FAIL — ${failed} case(s) (repo: ${config.REPO_ROOT})`
);
process.exit(failed === 0 ? 0 : 1);
