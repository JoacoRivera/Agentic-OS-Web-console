# Firefly III is a read-only external source reached over loopback

Status: accepted — 2026-09-17

## Context

Every data source the console has ever read is a **local filesystem clone**: `REPO_ROOT`
(the Agentic OS memory repo) and, since ADR-0010, `HEALTH_REPO_ROOT` (the private
`Health-Management` record). Verified on 2026-09-17: `platform/server/src/` and
`platform/scripts/` contain **no outbound HTTP call of any kind** — no `fetch(`, no
`axios`, no `undici`, no `https.request` — and the server's only dependencies are
`express` and `gray-matter`.

The owner keeps household finances in **Firefly III**, a self-hosted personal finance
manager running on this same host. `~/projects/firefly-iii/compose.yml` publishes it on
**`127.0.0.1:8081`** (loopback only); Caddy on the host terminates
`http://finances.home.arpa` and `http://aos-ubuntu.tail5d56e9.ts.net` and reverse-proxies
to that port. The console service runs beside it on `127.0.0.1:8084`.

The console wants a Finance section that answers *"am I on track this month?"* at a
glance, with long-term health below it, and **leaves all detail in Firefly** — every card
links back rather than reimplementing the ledger. The owner decided on 2026-09-17 that
the console is the *viewer*.

**Correction (2026-09-18):** this ADR originally recorded that decision as also settling
that the Home Management System does not own the finance surface. It did not. That reading
rested on a naming mix-up — the owner's remark referred to the `Health-Management` clone
(the Markdown clinical record of ADR-0010), not to the `home-management-system` TypeScript
monorepo, whose memory page still legitimately describes a Finance phase among its seven.
So the console being the viewer stands, but **the boundary between it and that project's
Finance module was never decided** and remains open. Nothing in this ADR depends on that
boundary; a future decision about it does not reopen anything decided here.

This introduces two firsts for the project, and they are the reason this ADR exists:

- **The first outbound network dependency.** A source that can be slow, down, or return
  something other than what we parsed last week — unlike a file, which is simply there.
- **The first stored credential.** A Firefly Personal Access Token in `console.env`
  changes the blast radius of that file: reading it yields access to the owner's
  finances, not merely to the console.

Two existing invariants shape the answer. ADR-0005: loopback bind is necessary but
insufficient, and sensitive content stays hidden by default even through the
authenticated tailnet proxy. ADR-0010: a new class of private data gets its own opt-in
config with no default, its own gate, read-only access, and a standing refusal to
interpret what it shows.

## Decision

1. **An optional external source with no default.** `FIREFLY_URL` and `FIREFLY_TOKEN` are
   set together or not at all; either alone is invalid configuration and the server
   refuses to start. Unset means the section does not exist — `404
   finance-not-configured` on every route, and the dashboard shows "not configured". As
   with `HEALTH_REPO_ROOT`, the location is per-machine and never guessed.

2. **The token never crosses a network in cleartext.** `FIREFLY_URL` must be either an
   `http://` URL whose host is loopback, or an `https://` URL. A plain-`http://`
   non-loopback Firefly is invalid configuration. On this host the correct value is
   `http://127.0.0.1:8081` — **not** `http://finances.home.arpa`: the public name would
   route out to Caddy and back to the same machine, adding an AdGuard DNS dependency and
   a network hop for nothing. Loopback-to-loopback keeps the credential off every network
   interface.

3. **Only `GET`.** The adapter exposes no write verb. Firefly remains the sole source of
   truth for the ledger; the console never mutates it, and "read-only" is enforced by the
   shape of the code rather than by configuration that could be flipped. **This decision
   stands unaided** (see Open questions, closed 2026-09-18): a Firefly Personal Access
   Token carries no scopes, so there is no read-only credential to fall back on and no
   second layer behind this one.

4. **`Accept: application/json` always; redirects are never followed.** Verified against
   the live instance on 2026-09-17: without that header Firefly's web middleware answers
   `302` to the login page, and with it an unauthenticated API call correctly answers
   `401 {"message":"Unauthenticated."}`. The adapter therefore sets the header on every
   request and uses `redirect: 'manual'`; a `3xx` is reported as a configuration error,
   never followed. Following it would land on an HTML login page that a JSON parser could
   misread as data.

5. **The token never leaves the server.** It is absent from the dashboard bundle, from
   `/api/status`, from server logs, and from every error body. The browser talks only to
   `/api/finance/*`; only the server talks to Firefly.

6. **Loopback-only by default, even behind the proxy.** Every `/api/finance/*` request
   arriving through `PROXY_HOSTNAME` is refused (`403 finance-proxy-refused`) unless
   `FINANCE_ALLOW_PROXY=true`. That flag is invalid configuration without both the
   `FIREFLY_*` pair and a configured proxy, and the server refuses to start. Turning it
   on for the tailnet is a deliberate owner decision recorded as an amendment here, not a
   deploy-time default. This mirrors ADR-0010 decision 3 exactly.

7. **No leakage into shared surfaces.** Financial data never enters `/api/metrics`,
   `/api/docs/tree|file|search|backlinks`, `/api/memory/query`, the Operations catalog,
   the audit log, server logs, or error messages. Error bodies carry codes only.

8. **Nothing financial at rest in this repository.** The cache is an in-process TTL cache,
   never a file. Test fixtures are invented and served by a fake Firefly; the tests never
   touch the live instance, even though it is reachable from the machine they run on.
   Real financial data never enters this repository, its tests, screenshots, commit
   messages, or memory captures about this work.

9. **Compute, chart, and link; never advise.** The console derives deterministic
   aggregates and shows each with its period and currency. Every pane carries the fixed
   line *"Indicators to decide with, never financial advice — the detail lives in
   Firefly."*, the analogue of ADR-0010's physician line. A figure that could not be
   computed is reported as absent **with its reason** — never as a zero. When Firefly is
   unreachable the section serves the last good value **labelled with its age**, or an
   explicit unreachable state; it never renders a blank panel or a stale number that
   claims to be current.

10. **Nothing here is executable.** Refreshing is a read, not an Operation. The Phase-3
    executable allowlist stays closed at its six deterministic checks (ADR-0001). Any
    future `check:finance` script prints counts only and stays **out** of the allowlist,
    for the same reason ADR-0010 kept `check:family-health` out: run output lands in the
    audit log and would be startable through the proxy.

11. **Multi-currency is structural, and amounts in different currencies are never
    summed.** Verified on the live instance: `summary/basic` returns currency-suffixed
    keys (`net-worth-in-PEN`, `bills-unpaid-in-USD`, …) and the household holds **PEN and
    USD**. The key set is **not** a cartesian product — on 2026-09-17 PEN carried all
    seven metrics and USD carried only `bills-unpaid`. The adapter therefore parses the
    `<metric>-in-<CODE>` key shape rather than reading fixed key names, treats a metric
    absent for a currency as absent (decision 9), and never adds figures across
    currencies: Firefly implies no exchange rate and neither may the console. Every
    displayed figure carries its own `currency_code` / `currency_symbol` /
    `currency_decimal_places`, which the API supplies per entry.

12. **The internal URL and the link URL are different config.** `FIREFLY_URL` is how the
    *server* reaches Firefly (loopback) and is never sent to the browser. A browser on
    another tailnet device cannot use a loopback address, so "open in Firefly" links are
    built from a separate, optional `FIREFLY_PUBLIC_URL` (here
    `http://finances.home.arpa`). That value is safe to expose — it is the name the owner
    already types and carries no credential; it is rejected if it embeds userinfo, and it
    is never used to make an API call. Unset simply means no links are rendered.

13. **The console owns its own labels.** Firefly returns localized display strings — the
    live instance answers `"Saldo (S/)"` even though its `.env` sets
    `DEFAULT_LANGUAGE=en_US`, because the profile preference wins. The console uses the
    stable `key` / `id` fields for identity and renders its own labels, so the UI language
    never depends on a Firefly profile setting changing underneath it.

## API map (verified 2026-09-17 against the live instance, Firefly III 6.6.6)

All endpoints below answered `200` over `http://127.0.0.1:8081/api/v1` with
`Accept: application/json` and a bearer PAT.

| Endpoint | Supplies | v1? |
|---|---|---|
| `/about` | version handshake / reachability probe | yes |
| `/summary/basic?start&end` | balance, earned, spent, left-to-spend, net worth, bills paid/unpaid — per currency | yes |
| `/accounts?type=asset` | the 4 asset accounts and their balances | yes |
| `/bills?start&end` | `pay_dates`, `paid_dates`, `repeat_freq`, `skip`, `active`, per-bill currency | yes |
| `/insight/expense/category?start&end` | spend per category for the window | yes |
| `/categories` | category identity | yes |
| `/budgets`, `/budget-limits?start&end` | budget pacing | **no data — see below** |
| `/chart/account/overview?start&end` | net-worth series | **no history — see below** |

**The instance holds one partial month of data.** On 2026-09-17 it reported: 45
transactions, *all* of them between 2026-09-02 and 2026-09-13; 4 asset accounts; 14
categories; 7 bills (1 with a `paid_date` this month); 1 piggy bank; and **zero budgets,
zero budget limits, zero tags, zero expense/revenue accounts**. `chart/account/overview`
returned a single entry for the whole month.

This is a **product** constraint, not a data-quality complaint, and it decides the shape
of v1:

- **Budget pacing — the intended headline indicator — has no input at all.** Not a
  degraded value: there are no budgets to pace against.
- **Every trend indicator is uncomputable**: moving averages, month-over-month deltas,
  months-of-runway (which needs an average spend across months) and the 12-month net-worth
  line all require history that does not exist yet.
- **What *is* computable today is a current-state view**: balances and net worth, earned
  and spent this month, left to spend, bills due and paid this month, and spend by
  category this month.

Therefore v1 ships the current-state band only. A history- or budget-dependent card is
**not** rendered as an empty chart or a zero; it states what is missing and what would
unlock it ("needs budgets configured in Firefly", "needs N months of history"), which is
the honest form of decision 9 and incidentally tells the owner what to go set up.

## Consequences

- New config: `FIREFLY_URL`, `FIREFLY_TOKEN` (both unset by default) and
  `FINANCE_ALLOW_PROXY` (default `false`). `/api/status` reports `financeConfigured` and
  `financeAllowProxy` as **booleans only** — never the URL, never the token.
- `console.env` becomes a higher-value target than it was. It stays `640 root:joaquin`,
  and the deployment notes must say plainly that it now holds finance access.
- Verification (performed, not recommended) must assert: unset config → 404 on every
  route; a plain-`http` non-loopback `FIREFLY_URL` refuses startup; either `FIREFLY_*`
  key alone refuses startup; `FINANCE_ALLOW_PROXY` without the pair or without a proxy
  refuses startup; a proxied request → 403 by default and 200 only with the flag; the
  token appears in no response, log, or error; `/api/metrics` and `/api/docs/*` remain
  unaware of Finance; Firefly unreachable → a degraded state carrying its age, not a
  silent zero.
- The console's charter widens again. It began as a console over the memory repo;
  ADR-0010 made it also a private read-only dashboard over a second local record, and
  this ADR adds a remote one. **The pattern, not just this module, is what is being
  decided**: an external source is opt-in, read-only, credential-on-the-server,
  loopback-preferred, proxy-refused by default, and barred from the shared surfaces. A
  third source should amend this ADR rather than invent a third shape.

## Open questions (must close before implementation)

- **~~The endpoint map is not yet written.~~** Closed 2026-09-17 — see
  [API map](#api-map-verified-2026-09-17-against-the-live-instance-firefly-iii-666).
- **~~Whether the `pc_*` (primary-currency) mirror fields are FX-converted.~~** Closed
  2026-09-17: a live `paid_dates` entry carried `amount: "27.93"` with `pc_amount: null`
  *and* a `foreign_amount` in USD. `pc_*` is not a dependable conversion, so nothing may be
  built on it and **decision 11 stands unaided** — cross-currency totals are simply not
  computed.
- **~~Whether Firefly Personal Access Tokens support read-only scopes.~~** Closed
  2026-09-18: **they do not.** The owner, who created the token, confirmed that the
  creation screen offered no scope or read-only option — the token is full access to their
  Firefly data and cannot be narrowed. (Owner recollection for this Firefly version, not an
  API capability the console verified.) The consequence is the one this question
  anticipated: **decision 3 now stands unaided.** "Only `GET`" is the sole thing between
  this credential and write access to the household ledger, so it is a property of the
  code's shape rather than of configuration, and any change to `finance.js` that
  introduces a non-`GET` call — or a helper that could issue one — is a
  `block`-level review finding, not a style note.
- **~~`FINANCE_ALLOW_PROXY` for the VPS.~~** Closed 2026-09-18 by the amendment below:
  the owner chose to serve Finance on the tailnet, on the same grounds already accepted
  for Family Health.

## Amendment — served on the owner's tailnet (2026-09-18)

The owner decided, the day after this ADR was accepted, to serve Finance through the
authenticated proxy at `aos-console.home.arpa`. Grounds stated by the owner: the same ones
already accepted for Family Health in the ADR-0010 amendment — only their own devices are
on the tailnet. The deployment therefore sets `FINANCE_ALLOW_PROXY=true` in
`/etc/aos-console/console.env`, alongside `FIREFLY_URL`, `FIREFLY_TOKEN` and
`FIREFLY_PUBLIC_URL`; `deploy/setup-vps.sh` writes all four when a Firefly token is
available, carrying the token over from the previous deployment so a re-run never loses it.

What does **not** change: the listener stays loopback; `FIREFLY_URL` stays
`http://127.0.0.1:8081` (loopback, so the token still never crosses a network — the public
name is only ever a link target); Caddy basic auth and the proxy secret still gate every
request first; only `GET` reaches Firefly; and decisions 3, 5, 7, 8, 9, 10, 11 and 13
stand unchanged.

The effective audience for the household's financial position is now every holder of the
console's basic-auth password inside the tailnet — the same boundary already accepted for
identifiable medical data. The password and the tailnet's device list are that boundary;
re-verify both before adding a device or sharing the password.
