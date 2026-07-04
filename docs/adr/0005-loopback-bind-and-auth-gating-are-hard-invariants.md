# Loopback bind and auth-gating are hard invariants, not recommendations

The Phase-1 console is a **localhost-only private console**. The server defaults to
`HOST=127.0.0.1` and calls `listen(PORT, HOST)`. Binding to a non-loopback interface
(anything other than `127.0.0.1` / `localhost` / `::1`) **without auth explicitly
configured is invalid configuration — the server must refuse to start**, rather than
relying on a "add auth later" human reminder.

We decided this because the read APIs are sensitive: `/api/docs/file` and
`/api/docs/search` expose the *contents* of `wiki/` and `raw/` memory, and `raw/` is the
candid, unreviewed tier — which today already holds NDA-grade client material (e.g. casino
KYC/AML/VIP docs under `raw/projects/bw2-casinos-4.8/`). The original plan's
`paths.safeResolve()` prevents reading *outside* the allowed roots but does nothing to make
the allowed roots safe to *expose* — two different problems. Path traversal protection is
not access control.

**Loopback bind is necessary but insufficient.** Loopback is not a boundary against the
user's own browser: any web page visited while the console runs can `fetch()` the API, and
**DNS rebinding** defeats the Same-Origin Policy — the classic attack against localhost dev
servers. Loopback is also shared on a multi-user host. So P1 must add Host/Origin checks
*and* default raw content to hidden — independent of any future auth design.

## Consequences

- Config gains `HOST=127.0.0.1` (default) alongside `PORT=3001`.
- Startup invariant: non-loopback `HOST` without configured auth → refuse to start.
- **Host/Origin defense (hard invariant, P1, not deferred to auth design):**
  - Validate the `Host` header against allowed loopback hosts only —
    `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>` — and reject anything else.
  - Reject API requests carrying a non-localhost `Origin`.
  - Do **not** enable permissive CORS.
  - DNS-rebinding defense is part of local-console security, not optional. This protects
    `wiki/` contents too, not just `raw/`.
- **Raw content exposure is split from raw metrics.** Raw *metrics* (counts, mtimes, growth,
  draft counts, health) are always computed internally from `raw/`. Raw *content* exposure
  over HTTP is **off by default** and requires an explicit opt-in. The flag is renamed
  `EXPOSE_RAW_CONTENT` (default `false`) to remove ambiguity; it gates **only** content:
  `GET /api/docs/file` for `raw/**`, raw bodies/snippets in `GET /api/docs/search`, and raw
  markdown preview in the UI. It does **not** gate metrics. If non-loopback hosting is ever
  enabled, raw content stays hidden unless auth **and** explicit `EXPOSE_RAW_CONTENT=true`
  are both set.
- Verification (Performed, not Recommended) must assert: loopback bind; non-loopback
  without auth fails startup; path traversal rejected; non-loopback `Host` header rejected;
  cross-origin `Origin` rejected; raw metrics work while raw content is hidden by default;
  raw content appears only with `EXPOSE_RAW_CONTENT=true`.
- Docs state plainly: Phase 1 is localhost-only and not safe for LAN/public exposure
  without auth.

## Principle

Path safety prevents reading outside the allowed roots; it does not make the allowed roots
safe to expose. Loopback bind is necessary but insufficient: P1 must also enforce
Host/Origin checks against DNS rebinding, and raw content exposure is disabled by default
(`EXPOSE_RAW_CONTENT=true` to opt in). Loopback bind, Host/Origin defense, and auth-gating
are mandatory safety boundaries.
