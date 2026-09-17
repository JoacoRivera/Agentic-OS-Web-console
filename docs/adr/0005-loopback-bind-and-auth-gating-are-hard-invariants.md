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

## Amendment — explicit local browser alias (2026-07-24)

The Host/Origin defense may additionally trust one operator-configured
`LOCAL_HOSTNAME`. It is restricted to either a single-label hostname or that
single label beneath the special-use `.localhost` domain (for example,
`agentic-os-console.localhost`), and is matched exactly for both `Host` and
`Origin`. `.localhost` is preferred because it resolves to loopback without an
operating-system hosts-file change; a bare single-label alias must be mapped to
`127.0.0.1` explicitly. Arbitrary DNS names, suffix matching, wildcard hosts, and
non-loopback binding remain forbidden. This provides a memorable local URL
without expanding the listener to the LAN or weakening the default-deny request
guard.

## Amendment — authenticated reverse-proxy hostname (2026-09-17)

The console may be served on the owner's tailnet at one exact DNS name through a
reverse proxy on the same host (`aos-console.home.arpa`, via Caddy). The listener
**stays loopback**; this amendment does not permit a non-loopback `HOST`, and
`AUTH_CONFIGURED` stays `false`.

- `PROXY_HOSTNAME` (one exact multi-label DNS name, no wildcards, no suffix match, not
  `.localhost`) and `PROXY_SECRET` (≥ 32 characters) are configured **together** or not at
  all; either alone is invalid configuration and the server refuses to start.
- The proxy owns user authentication (HTTP basic auth over every path) and injects the
  secret as `X-AOS-Proxy-Auth`, overwriting any client-supplied value.
- The API accepts `Host: <PROXY_HOSTNAME>` **only** with a matching secret (constant-time
  compare); without it the request is `403 forbidden-proxy`. So a DNS-rebinding page, or
  anything reaching the loopback port directly, cannot use the name.
- Proxied requests accept no `Origin` or exactly the proxy origin. The proxy and local
  allowlists never mix: the proxy origin is rejected on loopback-`Host` requests and vice
  versa. Still no CORS headers.
- `EXPOSE_RAW_CONTENT` keeps its default `false`; the proxy does not change raw gating.
- The owner chose to allow Executable Operations through the proxy: authenticated
  tailnet users may start the same allowlisted checks, behind the same dry-run + confirm.
- Verification asserts: proxy mode still binds loopback; proxy `Host` without the secret
  → 403; with it → 200; proxied cross-origin `Origin` → 403; raw content still hidden;
  half-configured proxy refuses to start.

Plain HTTP is accepted because `.home.arpa` cannot get a public certificate and tailnet
traffic between devices is WireGuard-encrypted. Deployment lives in `deploy/`.

## Principle

Path safety prevents reading outside the allowed roots; it does not make the allowed roots
safe to expose. Loopback bind is necessary but insufficient: P1 must also enforce
Host/Origin checks against DNS rebinding, and raw content exposure is disabled by default
(`EXPOSE_RAW_CONTENT=true` to opt in). Loopback bind, Host/Origin defense, and auth-gating
are mandatory safety boundaries.
