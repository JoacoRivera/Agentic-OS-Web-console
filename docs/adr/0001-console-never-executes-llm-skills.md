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

- Phase-3 executable allowlist is restricted to deterministic checks/scripts:
  `npm run verify`, `check:paths`, `check:docs`, `check:workflows`, `check:skills`,
  `check:metrics-parity`.
- `aos:ingest`, `aos:promote-draft`, `aos:capture-example` are removed from the executable
  allowlist unless separate deterministic tools are later designed.
- `/wiki-lint` splits into two concepts: the LLM skill (Guided Operation) and a future
  deterministic `check:wiki-structure` (Executable Operation).
