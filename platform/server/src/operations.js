/**
 * Operations catalog (ADR-0001): a *static* catalog of console-facing action
 * cards. Two strict subtypes and nothing else:
 *
 * - `guided` — checklist + command preview only. The console never mutates,
 *   never shells out, never invokes Claude. Every LLM-Skill-backed operation
 *   is guided — Skills need LLM judgment and are not console-executable.
 * - `executable` — deterministic allowlisted local code, wired in Phase 3
 *   (live since 2026-07-04): dry-run first, explicit confirm, single-flight,
 *   audited — see executor.js for the safety model.
 *
 * The `check:hud-parity` migration gate was retired by the human
 * HUD-deprecation sign-off of 2026-07-04 (ADR-0002 amendment); the
 * `migrationOnly` escape hatch remains for any future migration gate.
 *
 * Phase 2: guided operations may declare `params` — structured fill-ins for
 * the command preview. Each param's `<name>` token appears literally in
 * `commandPreview`; the dashboard substitutes the typed value into the text
 * the user copies. Params never leave the browser: no endpoint accepts them —
 * run/dry-run take only {confirm, confirmToken} for allowlisted ids.
 */

/** Permanent Phase-3 executable allowlist — deterministic checks only. */
export const EXECUTABLE_ALLOWLIST = [
  'verify',
  'check:paths',
  'check:docs',
  'check:workflows',
  'check:skills',
  'check:metrics-groundtruth',
];

const GUIDED_OPERATIONS = [
  {
    id: 'session-start',
    title: 'Session start',
    description:
      'Open a working session against the memory repo: load the schema, then recall before doing.',
    workflow: 'wiki/workflows/manual-operations.md',
    skill: 'aos-query-memory',
    checklist: [
      'Read AGENTS.md (the schema) at the start of the session.',
      'Recall relevant memory before working: run /aos-query-memory on the topic.',
      'Check wiki/log.md for the last lint entry — a 7+ day gap means a maintenance pass is due.',
      'Note any open drafts in the review queue before starting new work.',
    ],
    commandPreview: '/aos-query-memory <topic>',
    params: [
      { name: 'topic', label: 'Topic', hint: 'what you are about to work on' },
    ],
  },
  {
    id: 'task-mode-select',
    title: 'Classify the task mode',
    description:
      'Route a non-trivial task into one of the seven task modes before executing it.',
    workflow: 'wiki/workflows/task-modes.md',
    skill: 'aos-task-mode',
    checklist: [
      'Run /aos-task-mode to classify the task and emit the required-output skeleton.',
      'Pick the mode: exploration, implementation, production-change, hotfix, research, documentation, or memory-update.',
      'Declare it in the first line of the work (`Mode: <name>`).',
      'Apply the universal anti-fabrication rule to every claim.',
    ],
    commandPreview: '/aos-task-mode <task>',
    params: [
      {
        name: 'task',
        label: 'Task',
        hint: 'one-line description of the task to classify',
      },
    ],
  },
  {
    id: 'pre-edit-checklist',
    title: 'Pre-edit checklist',
    description: 'Guardrail hook run before touching a file (guardrail-hooks: pre-edit).',
    workflow: 'wiki/workflows/guardrail-hooks.md',
    skill: 'aos-hook',
    checklist: [
      'Confirm the file is in scope for the declared task mode.',
      'raw/ is immutable evidence — never edit or delete it (two narrow header carve-outs only).',
      'Check for a conflicting in-flight change (git status).',
      'Know the verification you will run after the edit.',
    ],
    commandPreview: '/aos-hook pre-edit',
  },
  {
    id: 'post-edit-checklist',
    title: 'Post-edit checklist',
    description: 'Guardrail hook run after an edit lands (guardrail-hooks: post-edit).',
    workflow: 'wiki/workflows/guardrail-hooks.md',
    skill: 'aos-hook',
    checklist: [
      'Re-read the diff — does it match the stated intent and nothing more?',
      'Run the checks the edit affects (lint, tests, link check).',
      'Update wiki/index.md if pages were added or recategorized.',
      'Separate verification performed from verification recommended.',
    ],
    commandPreview: '/aos-hook post-edit',
  },
  {
    id: 'memory-update',
    title: 'Ingest raw source into the wiki',
    description:
      'Promote raw/ source material into synthesized wiki/ pages (ingest workflow).',
    workflow: 'wiki/workflows/manual-operations.md',
    skill: 'aos-ingest',
    checklist: [
      'Place the source under raw/<topic>/<slug>-YYYY-MM-DD.ext first.',
      'Run the pre-memory-update guardrail hook (/aos-hook pre-memory-update).',
      'Synthesize into wiki/ pages — link, never copy-paste; cite the raw source.',
      'Update wiki/index.md and prepend an ingest entry to wiki/log.md.',
    ],
    commandPreview: '/aos-ingest <source>',
    params: [
      {
        name: 'source',
        label: 'Raw source path',
        hint: 'raw/<topic>/<slug>-YYYY-MM-DD.md',
      },
    ],
  },
  {
    id: 'capture-approved-example',
    title: 'Capture an approved example',
    description:
      'After the user approves a result, file it as a new raw/ draft capture (the capture half of the memory loop).',
    workflow: 'wiki/workflows/memory-quality.md',
    skill: 'aos-capture-approved-example',
    checklist: [
      'Confirm the user actually approved the result being captured.',
      'Write one raw/ file only, with a Status: Draft header line.',
      'Do not ingest in the same step — the draft goes through triage first.',
    ],
    commandPreview: '/aos-capture-approved-example',
  },
  {
    id: 'draft-review',
    title: 'Review draft captures',
    description:
      'Triage the draft queue: decide ingest / keep-as-draft / delete / merge for each raw capture.',
    workflow: 'wiki/workflows/memory-quality.md',
    skill: 'aos-promote-draft-memory',
    checklist: [
      'List raw drafts (the Review Queue section mirrors this).',
      'For each: is it worth remembering? Classify low-risk vs high-risk.',
      'On an ingest verdict, follow the delegated approval-flip rules.',
      'Leave high-risk review blocks for the user to resolve.',
    ],
    commandPreview: '/aos-promote-draft-memory <capture>',
    params: [
      {
        name: 'capture',
        label: 'Draft capture path',
        hint: 'a raw/ draft from the Review Queue',
      },
    ],
  },
  {
    id: 'wiki-lint',
    title: 'Wiki lint (judgment pass)',
    description:
      'Memory hygiene: deterministic checks first, then the LLM judgment checks (contradictions, drift, invented certainty).',
    workflow: 'wiki/workflows/manual-operations.md',
    skill: 'aos-wiki-lint',
    checklist: [
      'Run the deterministic linter first: python3 scripts/wiki-lint.py.',
      'Review by judgment: contradictions, orphan pages, missing cross-references, stale claims.',
      'Fix what you can, flag what you cannot.',
      'Prepend a lint entry to wiki/log.md — this resets the 7-day health cadence.',
    ],
    commandPreview: '/aos-wiki-lint',
  },
  {
    id: 'pre-commit',
    title: 'Pre-commit checklist',
    description:
      'Walk the pre-commit contract before committing — the commit decision stays with the user.',
    workflow: 'wiki/workflows/guardrail-hooks.md',
    skill: 'aos-pre-commit',
    checklist: [
      'Review git status and the full diff — scope matches the declared task mode.',
      'wiki/index.md and wiki/log.md reflect any page adds/moves.',
      'Skill mirrors are in sync: python3 scripts/sync-skills.py --check.',
      'Lint is clean and no stray/temporary files are staged.',
    ],
    commandPreview: '/aos-pre-commit',
  },
  {
    id: 'session-close',
    title: 'Session close',
    description: 'End-of-session checklist so nothing durable is left unfiled.',
    workflow: 'wiki/workflows/manual-operations.md',
    skill: null,
    checklist: [
      'New sources are filed under raw/.',
      'Affected wiki/ pages and wiki/index.md are updated.',
      'A log.md entry summarizing the session is prepended.',
      'No secrets, no invented facts, open questions preserved.',
    ],
    commandPreview: 'git status --short',
  },
];

const EXECUTABLE_OPERATIONS = [
  {
    id: 'verify',
    title: 'Console smoke checks',
    description:
      'Boot the server and assert the safety + API invariants (bind, Host/Origin defense, raw gating, 501s, build).',
    commandPreview: 'npm run verify',
  },
  {
    id: 'check:paths',
    title: 'Path-safety check',
    description: 'Assert paths.safeResolve rejects traversal, absolute paths, and out-of-root reads.',
    commandPreview: 'npm run check:paths',
  },
  {
    id: 'check:docs',
    title: 'Docs API check',
    description: 'Assert the docs tree/read/search/backlinks endpoints against the live repo.',
    commandPreview: 'npm run check:docs',
  },
  {
    id: 'check:workflows',
    title: 'Workflow registry check',
    description: 'Assert registry inclusion rules and the objective-defect status roll-up (ADR-0006/0007).',
    commandPreview: 'npm run check:workflows',
  },
  {
    id: 'check:skills',
    title: 'Skill registry check',
    description: 'Assert the skill registry matches an independent directory recount — no phantom skill.',
    commandPreview: 'npm run check:skills',
  },
  {
    id: 'check:metrics-groundtruth',
    title: 'Metrics ground-truth check',
    description:
      'Console metrics vs an independent filesystem recount — the permanent correctness check (no aos-hud.js dependency).',
    commandPreview: 'npm run check:metrics-groundtruth',
  },
];

function buildCatalog() {
  const operations = [
    ...GUIDED_OPERATIONS.map((op) => ({
      type: 'guided',
      skill: null,
      workflow: null,
      params: [],
      ...op,
    })),
    ...EXECUTABLE_OPERATIONS.map((op) => ({
      type: 'executable',
      skill: null,
      workflow: null,
      checklist: [],
      params: [],
      migrationOnly: false,
      ...op,
      // Execution landed with Phase 3: dry-run → confirm → run, audited.
      executableInPhase: 3,
    })),
  ];

  // ADR-0001 invariants, enforced at module load so a bad catalog edit fails
  // every request loudly instead of shipping a Skill as executable.
  for (const op of operations) {
    if (op.skill && op.type !== 'guided') {
      throw new Error(`ADR-0001 violation: skill-backed operation "${op.id}" must be guided`);
    }
    // Skill conformance: a skill-backed operation's command preview is that
    // skill's real invocation (`/aos-*`), never a retired/phantom name. The
    // verify smoke additionally cross-checks the names against the live
    // /api/skills directory scan.
    if (
      op.skill &&
      op.commandPreview !== `/${op.skill}` &&
      !op.commandPreview.startsWith(`/${op.skill} `)
    ) {
      throw new Error(
        `operation "${op.id}" is backed by /${op.skill} but its preview does not invoke it`
      );
    }
    if (op.type === 'executable' && !EXECUTABLE_ALLOWLIST.includes(op.id) && !op.migrationOnly) {
      throw new Error(
        `ADR-0001 violation: executable operation "${op.id}" is not in the permanent allowlist`
      );
    }
    // Params are preview fill-ins only: guided-only, and each must have a
    // matching <name> token in the preview text it substitutes into.
    if (op.params.length > 0 && op.type !== 'guided') {
      throw new Error(`operation "${op.id}" declares params but is not guided`);
    }
    for (const param of op.params) {
      if (!op.commandPreview.includes(`<${param.name}>`)) {
        throw new Error(
          `operation "${op.id}" param "${param.name}" has no <${param.name}> token in its command preview`
        );
      }
    }
  }
  return operations;
}

const CATALOG = buildCatalog();

/** GET /api/operations — the static catalog (no filesystem read, no state). */
export function listOperations() {
  return {
    operations: CATALOG,
    total: CATALOG.length,
    counts: {
      guided: CATALOG.filter((op) => op.type === 'guided').length,
      executable: CATALOG.filter((op) => op.type === 'executable').length,
    },
    allowlist: EXECUTABLE_ALLOWLIST,
    executionPhase: 3,
    executionEnabled: true,
    note:
      'Guided operations are interactive checklists + command previews (fill in, copy — never run); ' +
      'executable operations are the deterministic Phase-3 allowlist: dry-run → explicit confirm → ' +
      'run, one at a time, every run audited (ADR-0001).',
    generatedAt: new Date().toISOString(),
  };
}
