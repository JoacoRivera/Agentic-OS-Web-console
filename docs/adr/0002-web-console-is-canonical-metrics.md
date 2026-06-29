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
- `check:metrics-parity` is a **temporary** migration gate (web-console output vs. existing
  HUD definitions/expected counts), retired/relaxed after deprecation.
- Once trusted: mark `dashboards/Agentic OS Dashboard.md` and `dashboards/aos-hud.js`
  deprecated; remove any "both dashboards are authoritative" claim from docs/AGENTS.md.
- After deprecation, do not change the HUD except to add a visible deprecation notice.
- Fallback rule: *if* both dashboards must stay active beyond a short transition, switch to
  the shared `lib/aos-metrics` module instead.
