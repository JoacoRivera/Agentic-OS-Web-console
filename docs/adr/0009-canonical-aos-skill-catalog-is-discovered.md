# Canonical `aos-*` skill catalog is discovered, not fixed

Status: accepted — 2026-07-30

## Context

The console began with a catalog of five LLM-facing skills:
`ingest`, `query-memory`, `capture-approved-example`, `promote-draft-memory`, and
`wiki-lint`. That was true of the original 2026-06-29 design and remains a
historical fact in ADR-0001 and the original implementation plan.

The Agentic OS migration to the canonical `aos-*` namespace expanded the
observed catalog to 13 skills by 2026-07-04. That number was also a dated
observation, not a stable platform constant. On 2026-07-30 the live Agentic OS
repository contains these 15 canonical skills:

1. `aos-agent-router`
2. `aos-capture-approved-example`
3. `aos-eval`
4. `aos-hook`
5. `aos-implement`
6. `aos-ingest`
7. `aos-plan`
8. `aos-pre-commit`
9. `aos-promote-draft-memory`
10. `aos-query-memory`
11. `aos-reconcile`
12. `aos-task-mode`
13. `aos-test-wiki-lint`
14. `aos-verify-block`
15. `aos-wiki-lint`

The original five, the 13 observed on 2026-07-04, and the 15 observed today are
three compatible points in the catalog's history. Treating any one count as a
permanent invariant would make the console stale as soon as Agentic OS adds or
retires a skill.

## Decision

- The Skill Registry, `npm run verify`, and `npm run check:skills` discover and
  recount `.claude/skills/*/SKILL.md`. They report the observed total but never
  encode an expected count.
- A canonical skill's directory name and `SKILL.md` `frontmatter.name` must be
  exactly equal. The directory remains the dispatch identity used for registry
  `name` and `invocation`; the registry diagnoses metadata drift and
  `check:skills` fails it through an independent read.
- Every discovered LLM skill remains guided-only under ADR-0001: the console
  may describe it or offer copyable guidance, but never execute it. If a Skill
  is surfaced through an Operation, that Operation must be **Guided**. This
  applies to all 15 skills observed today and to future discovered skills.
- `aos-agent-router` is intentionally canonical even though it encapsulates
  model-specific routing policy. This decision records that exception
  consciously; it does not execute IMP-02 or authorize a routing refactor.
- Guided-operation previews are representative product flows, not exhaustive
  catalog coverage. The console does not create one Operation card per Skill
  merely for numerical parity and does not invent operations for the 15 current
  skills.
- Any preview that declares itself skill-backed must point to a skill present in
  the live `/api/skills` registry and invoke that same `aos-*` name. The Hero
  command bar may show the exhaustive invocation list because it derives that
  list directly from `/api/skills`; the static Operations catalog is not an
  exhaustive skill preview.

## Consequences

- Adding or removing a valid skill changes the registry and observed count
  without requiring a console code change.
- A missing, invalid, or mismatched `frontmatter.name` is visible in the
  registry and fails `check:skills`; it is not silently normalized.
- Fixture tests may still use a small, explicitly fixture-scoped catalog. They
  must not describe their count as the live repository's canonical total.
- ADR-0001's non-execution boundary remains binding. This ADR supersedes only
  its historical catalog names/count as a description of the current catalog.
- There is no requirement for 15 Guided Operation cards. Coverage grows from
  real user workflows, while skill-backed cards remain live-registry
  conformant.
