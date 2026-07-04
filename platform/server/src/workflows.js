import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { safeResolve } from './paths.js';
import { hrefResolvesTo, MD_LINK_RE, WIKILINK_RE } from './docs.js';

/**
 * Workflow registry (ADR-0006/0007): status is driven by objective defects
 * only; editorial niceties are informational and never turn a row yellow.
 * A workflow with no `workflow_kind` is Unclassified — the kind is never
 * inferred and there is no default. Precedence (first match wins):
 * Missing links > Needs review > Unclassified > Stale > OK.
 */

export const WORKFLOWS_ROOT = 'wiki/workflows';

// Data/example/result folders are related data, not workflows with status
// verdicts (matches the metrics' `non-example` rule).
const EXCLUDED_SEGMENTS = new Set(['examples', 'cases', 'results']);

/**
 * The closed `workflow_kind` vocabulary → its two derived booleans, the ONLY
 * kind-dependent status inputs (ADR-0006). In P1 only runbook/eval-suite are
 * status-distinct; the rest are status-equivalent labels — deliberately.
 */
export const WORKFLOW_KINDS = {
  runbook: { requiresVerification: true, requiresRunbookShape: true },
  'eval-suite': { requiresVerification: true, requiresRunbookShape: false },
  policy: { requiresVerification: false, requiresRunbookShape: false },
  reference: { requiresVerification: false, requiresRunbookShape: false },
  inventory: { requiresVerification: false, requiresRunbookShape: false },
  'style-guide': { requiresVerification: false, requiresRunbookShape: false },
};

export const STATUS_LABELS = {
  'missing-links': 'Missing links',
  'needs-review': 'Needs review',
  unclassified: 'Unclassified',
  stale: 'Stale',
  ok: 'OK',
};

export class NotAWorkflowError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotAWorkflowError';
    this.status = 400;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

const inExcludedDir = (relPath) =>
  relPath
    .slice(WORKFLOWS_ROOT.length + 1)
    .split('/')
    .slice(0, -1)
    .some((seg) => EXCLUDED_SEGMENTS.has(seg));

/** True when `text` links to repo-relative `target` (inline or wikilink). */
function textLinksTo(text, fromDir, target) {
  for (const [, rawHref] of text.matchAll(MD_LINK_RE)) {
    if (hrefResolvesTo(rawHref, fromDir, target)) return true;
  }
  const targetBase = path.posix.basename(target).replace(/\.md$/i, '').toLowerCase();
  for (const [, inner] of text.matchAll(WIKILINK_RE)) {
    const page = inner.split('|')[0].split('#')[0].trim();
    if (path.posix.basename(page).replace(/\.md$/i, '').toLowerCase() === targetBase) return true;
  }
  return false;
}

/** Shared once-per-request context: index/usage text + skill dir names. */
async function loadRegistryContext(config) {
  const read = async (rel) => {
    try {
      return await fs.readFile(path.join(config.REPO_ROOT, rel), 'utf8');
    } catch {
      return null;
    }
  };
  let skills = [];
  try {
    const entries = await fs.readdir(path.join(config.REPO_ROOT, '.claude/skills'), {
      withFileTypes: true,
    });
    skills = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    /* no skills root — informational check simply reports none */
  }
  return {
    indexText: await read('wiki/index.md'),
    usageText: await read('wiki/agentic-os-usage.md'),
    skills,
  };
}

// "Verification" means a stated validation method, not a magic heading — any
// of these satisfies it, and an explicit "not applicable" is itself a
// satisfying decision, never flagged (ADR-0006).
const VERIFICATION_RES = [
  /^#{1,6}[^\n]*verification/im,
  /manual run checklist/i,
  /result recording/i,
  /verification[^a-zA-Z0-9\n]{0,3}(not applicable|n\/a)/i,
];

// Runbook shape: some procedural structure — numbered steps, a checkbox
// list, or a checklist/steps/procedure section.
const RUNBOOK_SHAPE_RES = [
  /^[ \t]*\d+[.)][ \t]+/m,
  /^[ \t]*[-*][ \t]+\[[ xX]\][ \t]/m,
  /^#{1,6}[^\n]*(checklist|steps|procedure)/im,
];

const ACCEPTED_MARKER_RE = /accepted|standing/i;

/** Unaccepted TODO/FIXME lines + unaccepted "Open questions" headings. */
function findOpenTodos(body) {
  const problems = [];
  for (const line of body.split('\n')) {
    if (/\b(TODO|FIXME)\b/.test(line) && !ACCEPTED_MARKER_RE.test(line)) {
      problems.push(line.trim().slice(0, 120));
    } else if (/^#{1,6}[^\n]*open questions?/i.test(line) && !ACCEPTED_MARKER_RE.test(line)) {
      problems.push(line.trim().slice(0, 120));
    }
  }
  return problems;
}

/**
 * Evaluate one workflow file into its checks + rolled-up status.
 * Kind-independent defects (index link, metadata, TODOs) always apply;
 * kind-dependent checks are `n/a` while the workflow is Unclassified —
 * suppressed, never assumed passing (ADR-0007).
 */
function evaluateWorkflow(config, ctx, relPath, text, stat, now) {
  // Tolerant frontmatter parse — a broken YAML block is a metadata defect,
  // not an unreadable workflow.
  let fm = {};
  let body = text;
  const metadataProblems = [];
  try {
    const parsed = matter(text);
    fm = parsed.data ?? {};
    body = parsed.content;
  } catch {
    metadataProblems.push('frontmatter does not parse as YAML');
  }

  const declaredKind = fm.workflow_kind ?? null;
  const kindKnown = typeof declaredKind === 'string' && declaredKind in WORKFLOW_KINDS;
  if (declaredKind !== null && !kindKnown) {
    metadataProblems.push(
      `workflow_kind ${JSON.stringify(declaredKind)} is not one of: ${Object.keys(WORKFLOW_KINDS).join(', ')}`
    );
  }

  let exempt = [];
  if (fm.checks_exempt !== undefined) {
    if (Array.isArray(fm.checks_exempt) && fm.checks_exempt.every((c) => typeof c === 'string')) {
      exempt = fm.checks_exempt;
    } else if (typeof fm.checks_exempt === 'string') {
      exempt = [fm.checks_exempt];
    } else {
      metadataProblems.push('checks_exempt must be a list of check ids');
    }
  }
  if (fm.updated !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(fm.updated instanceof Date ? fm.updated.toISOString().slice(0, 10) : fm.updated))) {
    metadataProblems.push(`updated ${JSON.stringify(fm.updated)} is not a YYYY-MM-DD date`);
  }

  const isExempt = (id) => exempt.includes(id);
  const kindBooleans = kindKnown ? WORKFLOW_KINDS[declaredKind] : null;
  const checks = [];
  const required = (id, label, pass, detail = '') => {
    checks.push({
      id,
      label,
      category: 'required',
      status: isExempt(id) ? 'exempt' : pass ? 'pass' : 'fail',
      detail,
    });
  };
  const requiredIfKind = (id, label, applies, pass, detail = '') => {
    if (!kindKnown) {
      checks.push({ id, label, category: 'required', status: 'n/a', detail: 'unclassified — cannot judge' });
    } else if (!applies) {
      checks.push({ id, label, category: 'required', status: 'n/a', detail: `not expected for ${declaredKind}` });
    } else {
      required(id, label, pass, detail);
    }
  };
  const informational = (id, label, pass, detail = '') => {
    checks.push({ id, label, category: 'informational', status: pass ? 'pass' : 'fail', detail });
  };

  required(
    'indexed',
    'Linked from wiki/index.md',
    ctx.indexText !== null && textLinksTo(ctx.indexText, 'wiki', relPath),
    ctx.indexText === null ? 'wiki/index.md not found' : ''
  );
  required('metadata', 'Metadata is valid', metadataProblems.length === 0, metadataProblems.join('; '));
  const todos = findOpenTodos(body);
  required(
    'todos',
    'No unaccepted TODO/FIXME/open questions',
    todos.length === 0,
    todos.slice(0, 3).join(' · ')
  );
  requiredIfKind(
    'verification',
    'States a validation method',
    kindBooleans?.requiresVerification ?? false,
    VERIFICATION_RES.some((re) => re.test(body))
  );
  requiredIfKind(
    'runbook-shape',
    'Has runbook shape (steps/checklist)',
    kindBooleans?.requiresRunbookShape ?? false,
    RUNBOOK_SHAPE_RES.some((re) => re.test(body))
  );

  const baseDir = relPath.replace(/\.md$/i, '');
  informational('when-to-use', 'Defines "when to use"', /when to use/i.test(body));
  informational('related-skill', 'A related skill exists', ctx.skills.some((s) => text.includes(s)));
  informational(
    'usage-referenced',
    'Referenced from agentic-os-usage.md',
    ctx.usageText !== null && textLinksTo(ctx.usageText, 'wiki', relPath)
  );
  informational('has-examples', 'Has an examples/ folder', ctx.exampleDirs.has(`${baseDir}/examples`));

  // ---- status roll-up: first match wins (ADR-0006/0007) ----
  const failed = (id) => checks.find((c) => c.id === id)?.status === 'fail';
  let status;
  if (failed('indexed')) status = 'missing-links';
  else if (failed('metadata') || failed('todos') || failed('verification') || failed('runbook-shape'))
    status = 'needs-review';
  else if (!kindKnown) status = 'unclassified';
  else if (now.getTime() - stat.mtimeMs > config.WORKFLOW_STALE_DAYS * DAY_MS) status = 'stale';
  else status = 'ok';

  return {
    name: path.posix.basename(relPath).replace(/\.md$/i, ''),
    path: relPath,
    title: body.match(/^#[ \t]+(.+)$/m)?.[1]?.trim() ?? null,
    kind: kindKnown ? declaredKind : null,
    kindDeclared: declaredKind,
    requiresVerification: kindBooleans?.requiresVerification ?? null,
    requiresRunbookShape: kindBooleans?.requiresRunbookShape ?? null,
    checksExempt: exempt,
    mtime: new Date(stat.mtimeMs).toISOString(),
    status,
    statusLabel: STATUS_LABELS[status],
    failingRequired: checks.filter((c) => c.category === 'required' && c.status === 'fail').length,
    checks,
  };
}

/** Walk wiki/workflows collecting {workflowPaths, exampleDirs, relatedByDir}. */
async function scanWorkflowsRoot(config) {
  const workflowPaths = [];
  const exampleDirs = new Set();
  const relatedFiles = []; // files inside excluded dirs, as related data
  async function walk(rel) {
    let entries;
    try {
      entries = await fs.readdir(path.join(config.REPO_ROOT, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue;
        if (entry.name === 'examples') exampleDirs.add(relPath);
        await walk(relPath);
      } else if (entry.isFile()) {
        if (inExcludedDir(relPath)) relatedFiles.push(relPath);
        else if (entry.name.endsWith('.md')) workflowPaths.push(relPath);
      }
    }
  }
  await walk(WORKFLOWS_ROOT);
  return { workflowPaths: workflowPaths.sort(), exampleDirs, relatedFiles: relatedFiles.sort() };
}

/** GET /api/workflows — full registry + per-workflow checks + summary. */
export async function listWorkflows(config, now = new Date()) {
  const [{ workflowPaths, exampleDirs }, ctxBase] = await Promise.all([
    scanWorkflowsRoot(config),
    loadRegistryContext(config),
  ]);
  const ctx = { ...ctxBase, exampleDirs };

  const workflows = await Promise.all(
    workflowPaths.map(async (relPath) => {
      const abs = path.join(config.REPO_ROOT, relPath);
      const [text, stat] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)]);
      return evaluateWorkflow(config, ctx, relPath, text, stat, now);
    })
  );

  const summary = { total: workflows.length };
  for (const id of Object.keys(STATUS_LABELS)) {
    summary[id] = workflows.filter((w) => w.status === id).length;
  }
  return { workflows, summary, staleDays: config.WORKFLOW_STALE_DAYS, generatedAt: now.toISOString() };
}

/**
 * GET /api/workflow?path= — one workflow + its related data files (the
 * excluded examples/cases/results under its own folder). Query param, not
 * /:id — workflow paths contain slashes.
 */
export async function getWorkflow(config, relPathInput, now = new Date()) {
  const abs = safeResolve(config.REPO_ROOT, relPathInput);
  const relPath = path.relative(config.REPO_ROOT, abs).replaceAll('\\', '/');
  if (!relPath.startsWith(WORKFLOWS_ROOT + '/') || !relPath.endsWith('.md')) {
    throw new NotAWorkflowError(`not a workflow path: ${relPath}`);
  }
  if (inExcludedDir(relPath)) {
    throw new NotAWorkflowError(
      'examples/cases/results are related data, not workflows with status verdicts (ADR-0006)'
    );
  }

  const [text, stat] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)]);
  const [{ exampleDirs, relatedFiles }, ctxBase] = await Promise.all([
    scanWorkflowsRoot(config),
    loadRegistryContext(config),
  ]);
  const ctx = { ...ctxBase, exampleDirs };

  const workflow = evaluateWorkflow(config, ctx, relPath, text, stat, now);
  const ownDir = relPath.replace(/\.md$/i, '') + '/';
  return {
    ...workflow,
    absolutePath: abs,
    relatedFiles: relatedFiles.filter((f) => f.startsWith(ownDir)),
    generatedAt: now.toISOString(),
  };
}
