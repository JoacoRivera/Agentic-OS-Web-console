# Web console never executes LLM skills

> Catalog amendment (accepted 2026-07-30): the five names below are the
> historical 2026-06-29 baseline. [ADR-0009](0009-canonical-aos-skill-catalog-is-discovered.md)
> records the current canonical `aos-*` catalog and the discover/recount contract.
> This ADR's guided-only boundary remains unchanged.

> **Allowlist amendment (accepted 2026-11-14, approved by owner via top-10 run):** the
> permanent allowlist gains a seventh entry, `check:wiki-structure`. See
> [Allowlist amendment: memory-repo scripts](#allowlist-amendment-memory-repo-scripts-accepted-2026-11-14).

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
  `check:metrics-groundtruth`, and — since the 2026-11-14 amendment below —
  `check:wiki-structure`.
- **Historical migration gates** were a separate bucket, never part of the permanent
  allowlist. `check:hud-parity` was retired on 2026-07-04; the corresponding memory-repo
  files were removed on 2026-07-30. No HUD migration gate exists now (ADR-0002).
- `aos:ingest`, `aos:promote-draft`, `aos:capture-example` are removed from the executable
  allowlist unless separate deterministic tools are later designed.
- `/wiki-lint` splits into two concepts: the LLM skill (Guided Operation) and the
  deterministic `check:wiki-structure` (Executable Operation, allowlisted by the
  2026-11-14 amendment below).

## Allowlist amendment: memory-repo scripts (accepted 2026-11-14)

Status: **Accepted 2026-11-14** — approved by owner via top-10 run.

The permanent executable allowlist gains the entry in the table below. Each row is
decided on its own: a row can be accepted, changed or dropped without touching the rules
or the other rows.

| Allowlist id | What it runs (fixed, no arguments) | Status |
|---|---|---|
| `check:wiki-structure` | the memory repo's `scripts/wiki-lint.py` — the deterministic half of `/aos-wiki-lint` that this ADR already anticipated | Accepted 2026-11-14 |

This is the first entry whose code lives in `REPO_ROOT` rather than in this
repository. The rules that make that acceptable apply to **every** row of the table:

1. **Fixed command.** The script path and interpreter are fixed server-side. Nothing from
   the browser reaches the command line and no argument is ever passed (for the lint: no
   `--root`, no `--today`).
2. **Minimal environment.** The child gets a fixed, minimal environment. No console
   secret (`FIREFLY_TOKEN`, `PROXY_SECRET`, auth configuration) is visible to code that
   lives outside this repository.
3. **Read-only.** The script only reads the memory repo. The console disables bytecode
   writes, and the executor's before/after `git status` reports any change as a finding.
4. **Same executor.** Dry-run → explicit confirm → single-flight → audited, exactly as for
   the other entries. No scheduled or automatic run.
5. **No new trust relationship.** A row names a script the owner's own tooling already
   runs on this host (for the lint: the pre-commit githook). The console adds a trigger;
   anyone who can change that file can already run code as the owner.
6. **Still closed and enumerated.** This is not a class of "memory-repo scripts". A script
   that is not a row here is not executable; adding one is a recorded change to this table.

Unchanged: LLM Skills, `/aos-wiki-lint` and its judgment checks included, are Guided
Operations and are never executable.

A row's output may be shown outside the Audit Log (the lint result appears in the
Maintenance view) only as a snapshot of the last run. It does not feed metrics or the
maintenance-pass cadence.
