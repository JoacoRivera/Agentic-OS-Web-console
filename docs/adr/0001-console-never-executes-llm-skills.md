# Web console never executes LLM skills

> Catalog amendment (accepted 2026-07-30): the five names below are the
> historical 2026-06-29 baseline. [ADR-0009](0009-canonical-aos-skill-catalog-is-discovered.md)
> records the current canonical `aos-*` catalog and the discover/recount contract.
> This ADR's guided-only boundary remains unchanged.

The web console (`platform/`) distinguishes **Guided Operations** (checklist + command
preview, no side effects) from **Executable Operations** (deterministic allowlisted local
code only). LLM-facing Skills — `/ingest`, `/query-memory`, `/capture-approved-example`,
`/promote-draft-memory`, `/wiki-lint` — require LLM judgment and are therefore **never**
Executable Operations; the console may only guide a human through invoking them.

We decided this because the original Phase-3 allowlist (`aos:ingest`, `aos:promote-draft`,
`aos:capture-example`) implied the server could run Claude skills as npm scripts. It cannot:
there is no deterministic equivalent, and shelling out to headless Claude was rejected (no
arbitrary shell, no hidden LLM invocation from a browser-triggered action).

## Consequences

- **Permanent** Phase-3 executable allowlist (deterministic checks/scripts only):
  `npm run verify`, `check:paths`, `check:docs`, `check:workflows`, `check:skills`,
  `check:metrics-groundtruth`.
- **Historical migration gates** were a separate bucket, never part of the permanent
  allowlist. `check:hud-parity` was retired on 2026-07-04; the corresponding memory-repo
  files were removed on 2026-07-30. No HUD migration gate exists now (ADR-0002).
- `aos:ingest`, `aos:promote-draft`, `aos:capture-example` are removed from the executable
  allowlist unless separate deterministic tools are later designed.
- `/wiki-lint` splits into two concepts: the LLM skill (Guided Operation) and a future
  deterministic `check:wiki-structure` (Executable Operation).
