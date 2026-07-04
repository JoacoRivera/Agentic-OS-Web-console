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
| `npm test`       | In-process API tests (Seam 1: exported `app`, no bind)     |
| `npm run verify` | Boot smoke (Seam 2: real startup, bind + guard checks)     |
| `npm run check:metrics-groundtruth` | `/api/metrics` vs an independent filesystem recount (permanent check, ADR-0002; no `aos-hud.js` dependency) |

## Configuration (env)

`dev` / `start` / `verify` / `check:metrics-groundtruth` load `platform/.env` when it
exists (`--env-file-if-exists`, Node ≥ 22.9). This repo lives **outside** the memory repo,
so copy `.env.example` to `.env` once (it sets `REPO_ROOT=~/agents/agentic-os`) and plain
`npm start` works from this folder. `.env` is gitignored.

| Var                  | Default                          | Notes                                                        |
| -------------------- | -------------------------------- | ------------------------------------------------------------ |
| `PORT`               | `3001`                           |                                                              |
| `HOST`               | `127.0.0.1`                      | Non-loopback without auth **fails startup** (ADR-0005)       |
| `REPO_ROOT`          | `../../..` from `server/src/`    | Path to the Agentic OS memory repo. Set in `.env` when developing outside it (e.g. `REPO_ROOT=~/agents/agentic-os`) |
| `EXPOSE_RAW_CONTENT` | `false`                          | Gates raw **content** over HTTP only; raw metrics always computed (ADR-0005) |

## Metrics (`GET /api/metrics`)

The **canonical** memory-metrics implementation (ADR-0002): a live filesystem scan per
request (no cache — refresh is "fetch again"), porting the exact HUD definitions. Skip
basenames `index|log|_template|README`; counts `wikiN` (published memory — the headline),
`rawN` (append-only raw capture archive, **not** a backlog), `all` (files across
wiki+raw+templates+dashboards minus `_template`; **double-counts a promoted item** — never
"total memory"), `examples`, `projects`, `workflows`, `rawProj`, `rawFlow`; captures
`capN`/`draftN`/`apprN` + `drafts[]`; a 30-day `series` keyed on **`pathAddedDate`**
(`git log --diff-filter=A`; repository *file* growth, not knowledge accumulation —
ADR-0003); a 7-day `week` by mtime (`weekTotal`, `activeDays`); `recent`; `health` from
the first `lint` entry in `wiki/log.md`; `targets` + `trend`.

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

## HUD deprecation (signed off 2026-07-04)

This console is the **canonical** memory-metrics implementation; the Obsidian HUD
(`dashboards/aos-hud.js`) is **deprecated** (ADR-0002, sign-off recorded in the ADR's
amendment). The temporary `check:hud-parity` migration gate passed its final run against
the live repo and was **retired with the sign-off** — removed from the scripts, the
operations catalog, and the repo. The permanent correctness check is
`check:metrics-groundtruth`, which recounts the filesystem independently and never touches
`aos-hud.js`. The HUD files remain in the memory repo with a visible deprecation notice
and receive no further changes.

## Guided operations (Phase 2, `GET /api/operations`)

The Operations section renders the static catalog as **guided flows**: each guided
operation is an interactive checklist (per-browser progress via `localStorage`, with
reset) plus a command preview. Operations with `params` render fill-in inputs whose
values substitute into the preview's `<name>` tokens — producing the exact text the user
**copies and runs themselves** (in a terminal or a Claude session). Params never leave
the browser; no endpoint accepts them. The console still executes nothing: LLM Skills
are guided-only forever (ADR-0001), and the executable allowlist (deterministic checks
only) stays described-but-inert until Phase 3 — `run`/`dry-run` return `501`. The catalog
module enforces both invariants at load time, and additionally throws on a param without
a matching preview token.

## Security model (Phases 1–2)

- Loopback bind (`listen(PORT, HOST)`, default `127.0.0.1`); non-loopback `HOST`
  without configured auth is **invalid configuration** — startup fails non-zero.
- The API validates the `Host` header against loopback hosts and rejects cross-origin
  `Origin`s (DNS-rebinding defense). No permissive CORS.
- `POST /api/operations/:id/run` and `/dry-run` return `501` until Phase 3.
- Client-supplied paths go through `paths.safeResolve` (rejects `..`, absolute paths,
  anything outside the allowed roots). Path safety prevents reading outside the roots;
  it does **not** make the roots safe to expose — those are two different problems.
