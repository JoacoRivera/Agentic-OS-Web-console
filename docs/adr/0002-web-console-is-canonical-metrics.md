# Web console is the canonical metrics implementation; Obsidian HUD is deprecated

The web console (`platform/server/src/metrics.js`) becomes the single canonical
implementation of memory metrics. The Obsidian HUD (`dashboards/Agentic OS Dashboard.md`
+ `dashboards/aos-hud.js`) is demoted to a **migration reference** and deprecated once the
web console is trusted — not a long-term equal runtime.

We decided this to avoid maintaining two active copies of the same metric algorithm
indefinitely (the original plan "ported the exact definitions" into a second JS file, which
would silently drift). Rather than invest in a shared `lib/aos-metrics` module imported by
both runtimes, we retire one runtime.

## Considered Options

- **Shared `lib/aos-metrics` module** imported by both HUD and console — correct *if* both
  dashboards must stay active for more than a short transition. Rejected because the HUD is
  being retired; the shared-module cost isn't justified for a dying consumer.
- **Two copies + manual parity** (original plan) — rejected; rots on first regex edit.

## Consequences

- Implement web-console metrics as canonical (Phase 1).
- **Two distinct checks — the original `check:metrics-parity` conflated them:**
  - `check:metrics-groundtruth` — **permanent.** Compares `/api/metrics` against an
    *independent filesystem recount* (`wiki/`, `raw/`, skip rules, examples, workflow counts,
    draft-status parsing, …). It must **not** depend on `dashboards/aos-hud.js`. The
    filesystem is the permanent source of truth, so this check is permanent and lives in the
    Phase-3 allowlist (ADR-0001). Renamed now so the architecture doesn't inherit a stale
    migration concept.
  - `check:hud-parity` — **temporary migration gate.** Compares the new console against the
    Obsidian HUD *during migration only*. The HUD is a migration **oracle**, nothing more.
    Outside the permanent allowlist (or flagged `migrationOnly: true`).
- **Retirement trigger for `check:hud-parity`:** an **explicit human deprecation sign-off**
  for the HUD — recorded after `check:metrics-groundtruth` is green and the console is
  accepted as canonical. The trigger is a product/ownership transition, **not** "N green
  runs". **Owner:** the Agentic OS maintainer/operator. **Recorded as:** a new ADR (or an
  amendment to this one) stating "HUD deprecated; console metrics canonical; `check:hud-parity`
  retired", with the plan/README updated to drop the gate.
- Once trusted: mark `dashboards/Agentic OS Dashboard.md` and `dashboards/aos-hud.js`
  deprecated; remove any "both dashboards are authoritative" claim from docs/AGENTS.md.
- After deprecation, do not change the HUD except to add a visible deprecation notice.
- Fallback rule: *if* both dashboards must stay active beyond a short transition, switch to
  the shared `lib/aos-metrics` module instead.
