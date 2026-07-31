# Web console is canonical; legacy Obsidian HUD is retired and removed

Status: accepted; amended 2026-07-04 and 2026-07-30

The web console (`platform/server/src/metrics.js`) is the single canonical implementation
of memory metrics. Its active filesystem roots are `wiki/`, `raw/`, and `templates/`.
`dashboards/` is not a docs root, allowed path root, source kind, or metrics root.

## Original decision (historical)

Before the 2026-07-04 sign-off, the Obsidian HUD
(`dashboards/Agentic OS Dashboard.md` + `dashboards/aos-hud.js`) was used as a migration
reference, not a long-term equal runtime. This avoided maintaining two active copies of the
same metric algorithm indefinitely. Rather than invest in a shared `lib/aos-metrics` module
imported by both runtimes, the decision was to retire the Obsidian runtime.

## Considered Options

- **Shared `lib/aos-metrics` module** imported by both HUD and console — would have been
  correct if both dashboards had stayed active beyond the short transition. Rejected
  because only the console would remain active.
- **Two copies + manual parity** (original plan) — rejected; rots on first regex edit.

## Migration consequences (historical)

- Implement web-console metrics as canonical (Phase 1).
- **Two distinct checks — the original `check:metrics-parity` conflated them:**
  - `check:metrics-groundtruth` — **permanent.** Compares `/api/metrics` against an
    *independent filesystem recount* (`wiki/`, `raw/`, skip rules, examples, workflow counts,
    draft-status parsing, …). The filesystem is the permanent source of truth, so this
    check is permanent and lives in the Phase-3 allowlist (ADR-0001).
  - `check:hud-parity` — **temporary migration gate.** Compares the new console against the
    Obsidian HUD *during migration only*. The HUD is a migration **oracle**, nothing more.
    Outside the permanent allowlist (or flagged `migrationOnly: true`).
- **Retirement trigger for `check:hud-parity`:** an **explicit human deprecation sign-off**
  for the HUD — recorded after `check:metrics-groundtruth` is green and the console is
  accepted as canonical. The trigger is a product/ownership transition, **not** "N green
  runs". **Owner:** the Agentic OS maintainer/operator. **Recorded as:** a new ADR (or an
  amendment to this one) stating "HUD deprecated; console metrics canonical; `check:hud-parity`
  retired", with the plan/README updated to drop the gate.
- The planned transition was to mark the two HUD files deprecated once trusted and remove
  any "both dashboards are authoritative" claim.
- The fallback would have been a shared `lib/aos-metrics` module if both runtimes had
  remained active beyond a short transition.

## Sign-off (2026-07-04)

**HUD deprecated; console metrics canonical; `check:hud-parity` retired.**

Signed off by the Agentic OS maintainer/operator (Joaquin Rivera) on 2026-07-04, after
`check:metrics-groundtruth` passed against the live memory repo and the final
`check:hud-parity` run passed (all compared fields equal; `series`/`last30` deliberately
divergent per ADR-0003). Consequences applied:

- `check:hud-parity` removed from `platform/package.json`, the operations catalog, and
  `platform/scripts/` (last passing run recorded above).
- At sign-off, the two HUD files carried a visible deprecation notice. This interim state
  was superseded by the 2026-07-30 removal amendment below.
- At sign-off, `AGENTS.md` in the memory repo recorded the console as canonical.
- The permanent correctness check remains `check:metrics-groundtruth` only.

## Removal amendment (2026-07-30)

The Agentic OS maintainer removed `dashboards/Agentic OS Dashboard.md`,
`dashboards/aos-hud.js`, and `.obsidian/snippets/agentic-dashboard.css` from the memory
repo. The transition is complete; there is no legacy runtime or deprecation notice to
maintain.

Console consequences:

- `DOC_ROOTS` and source kinds cover only `AGENTS.md`, `wiki/`, `raw/`, `templates/`, and
  `.claude/skills/`.
- `ALLOWED_ROOTS` covers the same active surface; `safeResolve` rejects `dashboards/`
  even if a stale local directory exists.
- Metrics and `check:metrics-groundtruth` scan only `wiki/`, `raw/`, and `templates/`.
- Tests retain isolated stale-directory fixtures only to prove that the retired root is
  ignored or rejected.
