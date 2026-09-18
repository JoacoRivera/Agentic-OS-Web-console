# Agentic OS Web Console (Odysseus)

A **localhost-only private console** over the Agentic OS memory repo: canonical memory
metrics, docs browsing, and workflow/skill registries, read **live** from the filesystem.
Express backend (`server/`) + React/Vite frontend (`dashboard/`), npm workspaces.

**This console is not safe for LAN/public exposure without auth.** The server binds
loopback by default and refuses to start on a non-loopback `HOST` (no auth layer exists
yet) — see ADR-0005.

## Commands (run from `platform/`)

| Command          | What it does                                              |
| ---------------- | --------------------------------------------------------- |
| `npm install`    | Install both workspaces                                    |
| `npm run dev`    | Server on `:3001` (watch) + Vite dev server (`/api` proxy) |
| `npm run build`  | Build the dashboard to `dashboard/dist/`                   |
| `npm start`      | Serve API + built dashboard on `http://127.0.0.1:3001`     |
| `npm test`       | Server API tests, then React dashboard tests                |
| `npm run verify` | Boot smoke (Seam 2: real startup, bind + guard checks)     |
| `npm run check:paths` | `paths.safeResolve` rejects traversal/absolute/out-of-root (table test) |
| `npm run check:docs`  | Docs tree/read/search/backlinks + raw gating against the live repo |
| `npm run check:workflows` | Registry inclusion + status roll-up vs an independent recount (ADR-0006/0007) |
| `npm run check:skills` | Skill registry vs an independent recount, including exact `frontmatter.name` = directory conformance |
| `npm run check:metrics-groundtruth` | `/api/metrics` vs an independent recount of the active filesystem roots (permanent check, ADR-0002) |
| `npm run check:family-health` | Family Health record parses and stays confined to its own root; prints counts only; skips when `HEALTH_REPO_ROOT` is unset. **Not** in the executable allowlist (ADR-0010) |

## Test strategy

`npm test` preserves the server's in-process HTTP seam and then runs the dashboard
workspace with Vitest + jsdom + Testing Library. Dashboard test dependencies are declared
in `dashboard/package.json`; `dashboard/test/setup.js` installs jest-dom, explicit cleanup,
and the one missing browser primitive needed by navigation tests (`scrollIntoView`).
Network reads are mocked only at the browser `fetch` seam.

The dashboard suite verifies user-visible DOM behavior without snapshots: knowledge
lineage wording and SVG series endpoint/overflow, deterministic documentation heading IDs
and navigation, cross-document fragment timing, and Docs Explorer selection. It does not
replace a real-browser visual pass. jsdom has no layout or paint engine, so CSS geometry,
responsive behavior, SVG clipping/halo appearance, and the browser's real EventSource/SSE
stream still require browser-level validation. The baseline EXEC-13 run on 2026-07-30 was
120/120 server tests plus 7/7 dashboard tests. See ADR-0008.

## Configuration (env)

`dev` / `start` / `verify` / `check:metrics-groundtruth` load `platform/.env` when it
exists (`--env-file-if-exists`, Node ≥ 22.9). This repo lives **outside** the memory repo,
so copy `.env.example` to `.env` once (it sets `REPO_ROOT=~/projects/agentic-os`) and plain
`npm start` works from this folder. `.env` is gitignored.

| Var                  | Default                          | Notes                                                        |
| -------------------- | -------------------------------- | ------------------------------------------------------------ |
| `PORT`               | `3001`                           |                                                              |
| `HOST`               | `127.0.0.1`                      | Non-loopback without auth **fails startup** (ADR-0005)       |
| `LOCAL_HOSTNAME`     | unset                            | Optional local browser alias; prefer a `.localhost` name for automatic loopback resolution |
| `REPO_ROOT`          | `../../..` from `server/src/`    | Path to the Agentic OS memory repo. Set in `.env` when developing outside it (e.g. `REPO_ROOT=~/projects/agentic-os`) |
| `EXPOSE_RAW_CONTENT` | `false`                          | Gates raw **content** over HTTP only; raw metrics always computed (ADR-0005) |
| `PROXY_HOSTNAME`     | unset                            | Exact DNS name served by an authenticating reverse proxy (e.g. `aos-console.home.arpa`). Requires `PROXY_SECRET` |
| `PROXY_SECRET`       | unset                            | ≥ 32 chars; the proxy must send it as `X-AOS-Proxy-Auth`. Set with `PROXY_HOSTNAME` or not at all |
| `HEALTH_REPO_ROOT`   | unset                            | Family Health record: the local `Health-Management` clone (ADR-0010). Unset = section absent. Must not be inside `REPO_ROOT` (or contain it) — startup refuses |
| `FAMILY_HEALTH_ALLOW_PROXY` | `false`                   | `true` serves Family Health through the authenticated proxy. Requires `HEALTH_REPO_ROOT` and the `PROXY_*` pair, otherwise startup refuses |
| `FIREFLY_URL`        | unset                            | Firefly III API base (ADR-0011). Set with `FIREFLY_TOKEN` or not at all. Plain `http://` is allowed **only** for a loopback host — on this machine `http://127.0.0.1:8081`, not `finances.home.arpa` — so the token never crosses a network. `https://` for a remote instance |
| `FIREFLY_TOKEN`      | unset                            | Personal Access Token (Firefly: Options → Profile → OAuth). Server-side only: never in the bundle, `/api/status`, logs, or error bodies |
| `FIREFLY_PUBLIC_URL` | unset                            | Browser-facing address used **only** to build "open in Firefly" links (e.g. `http://finances.home.arpa`). Never used for an API call; rejected if it embeds credentials. Unset = no links |
| `FINANCE_ALLOW_PROXY`| `false`                          | `true` serves Finance through the authenticated proxy. Requires the `FIREFLY_*` pair and the `PROXY_*` pair, otherwise startup refuses |
| `FIREFLY_TIMEOUT_MS` | `8000`                           | Per-request budget for an upstream Firefly call |
| `FINANCE_CACHE_MS`   | `60000`                          | TTL of the in-process finance cache. Nothing financial is written to disk |
| `FINANCE_MIN_TREND_MONTHS` | `3`                        | Months of transaction history a trend indicator needs before it reports a value instead of what it is waiting for |

## Metrics (`GET /api/metrics`)

The **canonical** memory-metrics implementation (ADR-0002): a live filesystem scan per
request (no cache — refresh is "fetch again"), using the console metric contract. Skip
basenames `index|log|_template|README`; counts `wikiN` (published memory — the headline),
`rawN` (append-only raw capture archive, **not** a backlog), `all` (files across
wiki+raw+templates minus `_template`; **double-counts a promoted item** — never
"total memory"), `examples`, `projects`, `workflows`, `rawProj`, `rawFlow`; captures
`capN`/`draftN`/`apprN` + `drafts[]`; `knowledgeN` plus lineage coverage; a 30-day
knowledge-intake `series` keyed on explicit `source_id` + `knowledge_intake_date`
origins, with `promoted_from` pages resolving to those origins instead of counting
again (ADR-0003); a 7-day `week` by mtime (`weekTotal`, `activeDays`); `recent`; `health` from
the first `lint` entry in `wiki/log.md`; `trend`.

Lineage fields live in YAML frontmatter. Intake origins declare `source_id` and a bare,
unquoted `knowledge_intake_date: YYYY-MM-DD`; timestamps, quoted dates, comments, invalid
calendar dates, and future dates are invalid. Derived wiki pages declare `promoted_from`
as one raw Markdown path or a list. Missing or invalid lineage is excluded rather than
assigned a Git/mtime guess. `lineage` reports coverage counters plus at most 20
deterministically ordered `{path, reason}` entries in `problems` (reason then path), with
no file content. `reasonCounts` groups the same defects without that cap: a key-sorted map
of the reason codes actually present to positive integer counts, tallied over the full
problem set before truncation, `{}` when lineage is clean, counts only (no paths, no
content), and always summing to `unlineagedN + invalidN`. The chart states
`Lineage incomplete` whenever
`unlineagedN + invalidN > 0`, otherwise `Lineage complete`. See ADR-0003 for the stable
reason codes, complete contract, and examples.

## Memory query (`GET /api/memory/query?topic=`)

The Memory Query section performs deterministic, read-only recall over frontmatter tags in
`wiki/**/*.md`: it discovers matching tags, ranks published wiki pages by tag overlap, and
returns each page's path, title, one-line summary, and matched tags. It never searches or
returns `raw/` content, even when `EXPOSE_RAW_CONTENT=true`.

This endpoint only finds candidate pages; it does not synthesize an answer or execute an LLM
Skill. The dashboard offers a guided, copy-only Hermes handoff in the exact form
`/hermes-aos aos-query-memory <topic>`. The operator runs that command in Hermes; the console
never invokes Hermes, Claude, Codex, or an Agentic OS Skill (ADR-0001).

## Workflow registry (`GET /api/workflows`, `GET /api/workflow?path=`)

Scans `wiki/workflows/**.md`, excluding `**/{examples,cases,results}/**` (related data,
never status verdicts). Status comes from **objective defects only** (ADR-0006), first
match wins: `Missing links > Needs review > Unclassified > Stale > OK`. A workflow without
`workflow_kind` frontmatter is **Unclassified** — never inferred, never green (ADR-0007);
kind-independent defects (not indexed, broken metadata, unaccepted TODO/FIXME/open
questions) still apply and out-rank it. `workflow_kind` maps to two booleans
(`requires_verification`, `requires_runbook_shape`); only `runbook`/`eval-suite` are
status-distinct in P1. "Verification" means a stated validation method (`## Verification`,
a "Manual run checklist", "Result recording", or an explicit "Verification: not
applicable"), and `checks_exempt: [<check-id>]` opts out of a check that legitimately
doesn't apply. Editorial niceties (examples, "when to use", related skill, usage
reference) are informational-only. Per-workflow lookups use `?path=` — workflow paths
contain slashes.

## Skill registry (`GET /api/skills`)

Scans `.claude/skills/*/SKILL.md` in stable directory-name order. A skill's `name` and
`invocation` (`/<name>`) always come from its directory because that is the canonical
dispatch identity; frontmatter can never rename the invocation. Each row also exposes
`declaredName` (the exact parsed non-empty string, otherwise `null`) and a bounded `nameDiagnostic`:
`null` when names agree, or `{code, expected}` with code
`frontmatter-name-mismatch`, `missing-frontmatter-name`, or
`invalid-frontmatter-name`. Diagnostics contain no skill body or invalid metadata value.

`npm run check:skills` independently reads the initial frontmatter block rather than
reusing the registry parser. It checks every discovered skill and exits non-zero when
`frontmatter.name !== directoryName`, with deterministic directory-name ordering.
The registry, `verify`, and `check:skills` report whatever count they observe; none fixes
an expected total. The 15 skills seen on 2026-07-30 are a dated snapshot under
[ADR-0009](../docs/adr/0009-canonical-aos-skill-catalog-is-discovered.md), not a code
constant.

## Family Health (`GET /api/family-health/*`, ADR-0010)

A read-only view over the owner's **separate private** family medical record
(`Health-Management`: `family-overview.md`, `members/<name>/{profile,history}.md`,
`members/<name>/exams/YYYY-MM-DD_topic.md`, `members/<name>/documents/`, `reference/`).
It is a **second repo root** named by `HEALTH_REPO_ROOT`, never a memory root: its paths
resolve with `paths.safeResolve` against that root and the allowed roots
`family-overview.md`, `members/`, `reference/` only. `/api/docs/*` cannot reach it and it
cannot reach the memory repo.

| Route | Returns |
| --- | --- |
| `GET /api/family-health/summary` | one row per member folder (template excluded) with counts, the `family-overview.md` row, and the wiki page path when `wiki/projects/family-health-tracker/<slug>.md` exists |
| `GET /api/family-health/members` | the member list |
| `GET /api/family-health/member?name=` | profile fields, timeline entries, exam-note summaries (`kind: results \| narrative` plus a per-section outline of headings, counts and table headers — no body text), original documents **by name/size/absolute path only**, pending items, numeric markers |
| `GET /api/family-health/pending[?member=]` | explicit signals only: unchecked `- [ ]` items, bold `Pendiente`/`Pending` markers, result rows whose value is `Pending`, exam notes whose original is recorded missing; plus `reference/*.md` checklists |
| `GET /api/family-health/trends?member=&marker=` | numeric results for one marker across exam notes; each point carries the unit and reference range printed on its own note; non-numeric rows are counted as excluded |
| `GET /api/family-health/file?path=` | one Markdown file inside the health root (binaries → 404) |

An exam note with no results-shaped table (no table carrying both a result column and a
reference-range column — visit, ultrasound and prescription notes on the live record) is a
**narrative note**. The member file lists those under their own *Narrative notes* tab with a
per-section outline; results notes stay under *Exam notes* and are the only ones feeding
flagged counts, markers and Trends. `stats.narrativeN` / `totals.narrativeN` count them.

Gates, in order: unset `HEALTH_REPO_ROOT` → `404 family-health-not-configured` on every
route; a request through `PROXY_HOSTNAME` → `403 family-health-proxy-refused` unless
`FAMILY_HEALTH_ALLOW_PROXY=true` (loopback-only by default, even behind the authenticated
proxy); path safety → `400`. Error bodies carry codes, never paths or content. Family-health
data never enters metrics, docs search, memory query, the Operations catalog, or the audit
log. The console renders rows verbatim and computes only counts, dates and series — every
clinical pane carries "Data to raise with a physician, never a diagnosis." Fixtures under
`server/test/fixtures/family-health/` are synthetic.

## Finance (`GET /api/finance/*`, ADR-0011)

The console's **first outbound network dependency** and first stored credential: a
read-only glance over a live Firefly III. Unset `FIREFLY_URL`/`FIREFLY_TOKEN` → `404
finance-not-configured` on every route and the section says so. Through `PROXY_HOSTNAME`
every route is `403 finance-proxy-refused` unless `FINANCE_ALLOW_PROXY=true`.

Routes: `status` (version + link base), `summary` (balance, earned, spent, left to spend,
net worth, savings rate — per currency), `bills`, `budgets` (pacing), `categories`,
`trends`. Only `GET` ever reaches Firefly, always with `Accept: application/json` and
`redirect: 'manual'` — without that header Firefly answers `302` to its login page, and
following it would hand HTML to a JSON parser.

Two rules decide most of the behaviour:

- **A figure that cannot be computed is absent with its reason, never a zero.** With no
  budgets configured the pacing card reports "Budgets with limits configured in Firefly
  III"; with too little history the trend cards report how many months they still need. A
  zero and "no data yet" mean opposite things on a finance dashboard.
- **Amounts in different currencies are never summed.** `summary/basic` answers
  currency-suffixed keys (`net-worth-in-PEN`, `bills-unpaid-in-USD`) and the key set is
  *not* a cartesian product — a metric can exist for one currency and be missing for
  another. Firefly implies no exchange rate (`pc_*` mirror fields are not a dependable
  conversion), so neither does the console.

A slow or briefly unreachable Firefly degrades to the last good value carrying its age
(`stale`, `ageMs`, `staleReason`), never to a blank panel. Nothing financial is written to
disk, nothing reaches metrics/docs/memory-query/Operations/the audit log, and nothing here
is executable — the Phase-3 allowlist stays closed. Tests use a fake Firefly on loopback
with invented figures and never touch the live instance.

## Legacy HUD retirement (completed 2026-07-30)

The console is the **canonical** memory-metrics implementation. The migration gate
`check:hud-parity` passed its final run and was retired on 2026-07-04. On 2026-07-30 the
memory repo removed `dashboards/Agentic OS Dashboard.md`, `dashboards/aos-hud.js`, and the
associated Obsidian CSS snippet. Consequently `dashboards/` is neither a docs root, an
allowed path root, nor a metrics scan root. The permanent correctness check is
`check:metrics-groundtruth`, which independently recounts `wiki/`, `raw/`, and
`templates/`.

## Guided operations (Phase 2, `GET /api/operations`)

The Operations section renders the static catalog as **guided flows**: each guided
operation is an interactive checklist (per-browser progress via `localStorage`, with
reset) plus a command preview. Operations with `params` render fill-in inputs whose
values substitute into the preview's `<name>` tokens — producing the exact text the user
**copies and runs themselves** (in a terminal or a Claude session). Params never leave
the browser; no endpoint accepts them. LLM Skills are guided-only forever (ADR-0001);
the catalog module enforces the invariants at load time, and additionally throws on a
param without a matching preview token.
These cards are representative flows, not exhaustive Skill coverage. The Hero command
bar is the exhaustive invocation surface and reads `/api/skills` live; `verify`
cross-checks every static skill-backed preview against that same registry. No
one-card-per-Skill parity is required (ADR-0009).

## Controlled execution (Phase 3, `POST /api/operations/:id/{dry-run,run}`)

Only the **permanent executable allowlist** runs — the six deterministic checks
(`verify`, `check:paths`, `check:docs`, `check:workflows`, `check:skills`,
`check:metrics-groundtruth`), each mapped to its fixed `npm run <id>` in a server-side
command table. The client-supplied `:id` only selects a row; it is never interpolated,
and `spawn()` runs with `shell: false`. The flow (`server/src/executor.js`):

1. **Dry-run** describes the exact command/cwd and issues a **single-use confirm token**
   (10-minute TTL, bound to the operation id). Nothing executes.
2. **Run** requires `{"confirm": true, "confirmToken": ...}`; anything else is `400`.
   Guided/unknown ids are `405 not-executable`; a concurrent run is `409` (single-flight).
   Since Phase 4.2, run answers `202` with a `runId` immediately; progress via
   `GET /api/operations/runs/:runId` (snapshot) and `.../events` (SSE: `snapshot`,
   `output` chunks, final `done`) — same-origin only, behind the same Host/Origin guard.
3. Around every run: `git status --porcelain` before/after and a `git diff` when anything
   changed (the checks are read-only — a non-empty diff is itself a finding), plus
   stdout/stderr (tail-capped) and the exit code.
4. Every run — ok, failed, or timeout — appends one JSON line (op, ts, status, files,
   output) to `platform/logs/operations.log` at completion, tailed by `GET /api/audit`.
   Retention (Phase 4.3): size-based rollover (`AUDIT_ROTATE_BYTES`, default 1 MB, keeping
   `AUDIT_ROTATE_KEEP` rotated files, default 3); rotation renames whole files only and the
   reader spans rotated files, so the tail is loss-free across the boundary.

CI (Phase 4.1, `.github/workflows/ci.yml`) runs the repo-independent subset on push/PR:
`npm ci`, `npm test`, `npm run check:paths`, `npm run build`. The live-repo checks stay
local/manual — they need the memory repo.

## Security model

- Loopback bind (`listen(PORT, HOST)`, default `127.0.0.1`); non-loopback `HOST`
  without configured auth is **invalid configuration** — startup fails non-zero.
- The API validates the `Host` header against loopback hosts plus, when configured,
  one explicit local `LOCAL_HOSTNAME`, and rejects every other `Origin`
  (DNS-rebinding defense). No permissive CORS.
- Optional tailnet serving (ADR-0005 amendment, 2026-09-17): with `PROXY_HOSTNAME` +
  `PROXY_SECRET`, requests for that exact `Host` are accepted only when they carry the
  secret header the proxy injects, and only with no `Origin` or that same origin. The bind
  stays loopback; the proxy (Caddy basic auth) authenticates users. See `../deploy/README.md`.
- `POST /api/operations/:id/run` and `/dry-run` accept only the executable allowlist,
  behind dry-run + explicit confirm (see Controlled execution above). No generic shell
  endpoint exists.
- Client-supplied paths go through `paths.safeResolve` (rejects `..`, absolute paths,
  anything outside `wiki/`, `raw/`, `templates/`, `.claude/skills/`, and `AGENTS.md`).
  Path safety prevents reading outside the roots; it does **not** make the roots safe to
  expose — those are two different problems.
