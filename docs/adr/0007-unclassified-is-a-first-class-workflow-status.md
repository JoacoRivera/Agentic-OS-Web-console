# Unclassified is a first-class Workflow Registry status; no inferred default kind

## Status

accepted — refines ADR-0006 (does not supersede it).

## Decision

A workflow with no `workflow_kind` frontmatter is **Unclassified**: a distinct
WorkflowRegistry status, not silently treated as any concrete kind. The kind is **never
inferred** from title, tags, or filename. The console may *suggest* a likely kind in the UI,
but status logic must treat a missing `workflow_kind` as "cannot judge the kind-dependent
checks".

Concretely:

- **No default kind.** We rejected `default = reference` ("least-demanding"): it would grade
  the most procedure-heavy doc (`manual-operations.md`, a runbook) under the weakest checks
  and paint it green precisely because it is under-checked — a false `OK` on the registry's
  flagship row.
- **First paint is honest, not green.** On the current repo all ten real workflow docs are
  Unclassified. The registry must show e.g. `0 OK / 10 unclassified`, not ten greens. Green
  before classification destroys the tool's credibility.
- **Kind-independent defects still apply.** Unclassified suppresses only kind-*dependent*
  checks (e.g. "verification expected for this kind", runbook shape). Kind-*independent*
  objective defects — not linked from `index.md` (Missing links), broken/unsafe metadata,
  unaccepted TODO/FIXME (Needs review) — are still evaluated and out-rank Unclassified.
- **Status precedence becomes:** `Missing links > Needs review > Unclassified > Stale > OK`.
  A real defect surfaces above "unclassified"; a structurally clean but un-annotated row
  shows `Unclassified` (we can't confirm its kind-required checks pass), never `OK`. Stale
  ranks below Unclassified — if we can't classify it, "classify me" is more actionable than
  "you haven't touched me in 90 days".

## Backfill is P1 definition of done

If the Workflow Registry is a P1 ship target, then either (a) P1 includes classifying the
ten existing workflows, or (b) P1 ships an honest metadata audit that is all-Unclassified.
We choose (a): it is only ten files and the categories are already known. The agreed initial
classification (to be written as `workflow_kind` frontmatter in the Agentic OS repo's
`wiki/workflows/*.md` during P1):

| Workflow                     | workflow_kind |
| ---------------------------- | ------------- |
| `manual-operations.md`       | runbook       |
| `ai-code-review.md`          | runbook       |
| `task-modes.md`              | policy        |
| `verification.md`            | policy        |
| `guardrail-hooks.md`         | policy        |
| `context-engineering.md`     | policy        |
| `memory-quality.md`          | policy        |
| `evals.md`                   | eval-suite    |
| `harness-inventory.md`       | inventory     |
| `german-technical-emails.md` | style-guide   |

(`ai-code-review.md` is a runbook: required-conditions + an A–J checklist + severity levels
+ a defined output format. Its `## Open questions` heading will legitimately surface as a
candidate *Needs review* under ADR-0006 unless those questions are marked standing/accepted.)
