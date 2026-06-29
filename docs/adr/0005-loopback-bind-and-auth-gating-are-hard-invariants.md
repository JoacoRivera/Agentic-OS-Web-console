# Loopback bind and auth-gating are hard invariants, not recommendations

The Phase-1 console is a **localhost-only private console**. The server defaults to
`HOST=127.0.0.1` and calls `listen(PORT, HOST)`. Binding to a non-loopback interface
(anything other than `127.0.0.1` / `localhost` / `::1`) **without auth explicitly
configured is invalid configuration — the server must refuse to start**, rather than
relying on a "add auth later" human reminder.

We decided this because the read APIs are sensitive: `/api/docs/file` and
`/api/docs/search` expose the *contents* of `wiki/` and `raw/` memory, and `raw/` is the
candid, unreviewed tier. The original plan's `paths.safeResolve()` prevents reading
*outside* the allowed roots but does nothing to make the allowed roots safe to *expose* —
two different problems. Path traversal protection is not access control.

## Consequences

- Config gains `HOST=127.0.0.1` (default) alongside `PORT=3001`.
- Startup invariant: non-loopback `HOST` without configured auth → refuse to start.
- `raw/` exposure gated by `EXPOSE_RAW` (defaults true only on loopback). If non-loopback
  hosting is ever enabled, `raw/` defaults to hidden unless auth **and** explicit
  `EXPOSE_RAW=true` are both set.
- Verification (Performed, not Recommended) must assert: loopback bind; non-loopback
  without auth fails startup; path traversal rejected; raw-exposure follows config.
- Docs state plainly: Phase 1 is localhost-only and not safe for LAN/public exposure
  without auth.

## Principle

Path safety prevents reading outside the allowed roots; it does not make the allowed roots
safe to expose. Loopback bind and auth-gating are mandatory safety boundaries.
