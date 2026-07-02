# Web console never executes LLM skills

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
- **Migration gates** are a *separate* bucket, **not** part of the permanent allowlist:
  `check:hud-parity` (temporary; compares console vs. the Obsidian HUD during migration
  only). If it lives near the allowlist in code it must be flagged `migrationOnly: true` so
  it is never mistaken for a permanent member. The permanent allowlist must not depend on
  `dashboards/aos-hud.js`. See ADR-0002 for the parity split and retirement.
- `aos:ingest`, `aos:promote-draft`, `aos:capture-example` are removed from the executable
  allowlist unless separate deterministic tools are later designed.
- `/wiki-lint` splits into two concepts: the LLM skill (Guided Operation) and a future
  deterministic `check:wiki-structure` (Executable Operation).
