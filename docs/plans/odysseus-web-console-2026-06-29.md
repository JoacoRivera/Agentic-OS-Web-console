# Odysseus-style Agentic OS Web Console

---
Status: draft
Project: agentic-os-web-console
Type: implementation-plan
Date: 2026-06-29
---

## Context

The Agentic OS repo has an Obsidian HUD dashboard (`dashboards/Agentic OS Dashboard.md`
+ `dashboards/aos-hud.js` + `.obsidian/snippets/agentic-dashboard.css`) that only renders
inside Obsidian (needs Dataview JS) in a burnt-orange terminal aesthetic.

The user wants a web app console that becomes the **canonical** home for memory metrics.
The Obsidian HUD is **not** a long-term equal runtime: during Phase 1 the console must match
it closely enough to validate migration, after which the HUD becomes **legacy/deprecated**
(see ADR-0002). It must (1) surface the same memory metrics read **live** from the
filesystem — as the canonical implementation — (2) adopt the **Odysseus** visual style
(reference image
`pewdiepie-archdaemon/odysseus/docs/odysseus-browser.jpg`: dark slate bg, left **sidebar
nav**, **monospace** type, muted **coral/rose accent** `~#e08a8a`, small status dots,
rounded panels with 1px borders), and (3) run on a **live Node/Express server** that, in
Phase 1, doubles as a **static frontend launcher** for the user's future built
React/Angular/Vite apps. **"Host" here means serve static `dist/` builds — it does not run
Node/Nest backend processes.** Backend/Nest hosting is explicitly out of scope and deferred
to a separate future "local app supervisor" project with its own process model and security
review (see ADR-0004).

Beyond metrics, the goal is an **operating console** for the Agentic OS: browse the docs,
check workflows/skills for completeness, and run guided operations — not just a pretty HUD.

Stack (decided with user): **Express** backend, **React + Vite** frontend, **live** reads.

### Grounded repo facts (verified this session — do not invent beyond these)
- Repo-local skills live in `.claude/skills/<name>/SKILL.md`. There are exactly **five**:
  `ingest`, `query-memory`, `wiki-lint`, `capture-approved-example`,
  `promote-draft-memory`. (Plus a legacy pointer `skills/ingest.md`.)
  **There is no `/bw2-update-memory` skill** — the Skill Registry scans the directory and
  shows what exists; it must not hardcode a phantom skill.
- Workflows under `wiki/workflows/`: `manual-operations`, `task-modes`, `evals`,
  `verification`, `guardrail-hooks`, `harness-inventory`, `context-engineering`,
  `ai-code-review`, `memory-quality`, `german-technical-emails`, plus `evals/cases/*`,
  `evals/results/*`, `task-modes/examples/*`, `german-technical-emails/examples/*`.
- wiki top level: `agentic-os-setup`, `agentic-os-usage`, `index`, `lessons`, `log`,
  `_template`. Current size: 45 wiki `.md`, 42 raw files.
- The repo is deliberately at the **"manual harness, not yet automated"** stage
  (`wiki/workflows/manual-operations.md`). So the console's Operations stay **read-only /
  guided** (command preview + checklists) until Phase 3.

## Target layout

New top-level `platform/` (separate from the vault; never touches `dashboards/`, `wiki/`,
`raw/`, `.claude/`):

```
platform/
  package.json            # npm workspaces ["server","dashboard"] + dev/build/start/verify
  README.md
  scripts/verify.mjs      # scriptable smoke checks (npm run verify)
  logs/operations.log     # audit sink (gitignored)
  server/
    package.json          # express, gray-matter (frontmatter parse)
    src/
      index.js            # Express: API routes + static hosting + future-app mounts
      config.js           # tunable thresholds/limits (single source)
      paths.js            # central repo-root path safety (normalize, no .. / absolute)
      metrics.js          # live file scan -> metrics (ports aos-hud.js logic)
      gitdates.js         # creation dates via one `git log` pass
      docs.js             # docs tree / file read / search / backlinks
      workflows.js        # workflow registry + completeness checks
      skills.js           # repo-local skill registry (scans .claude/skills/)
      operations.js       # allowlisted guided operations (preview now, run in P3)
      audit.js            # append + read operation log
  dashboard/
    package.json          # react, react-dom, vite, @vitejs/plugin-react, lucide-react,
                          #   react-markdown, remark-gfm
    vite.config.js        # /api proxy -> :3001 in dev; build -> dist/
    index.html
    src/
      main.jsx
      App.jsx             # router/section state, fetches APIs
      theme.css           # Odysseus design tokens
      components/
        Sidebar.jsx StatCards.jsx GrowthChart.jsx HealthPanel.jsx
        ReviewQueue.jsx RecentActivity.jsx WeekBars.jsx Integrations.jsx Hero.jsx
        RepoHealth.jsx                               # one diagnostic card (P1)
        DocsExplorer.jsx MarkdownViewer.jsx          # docs (P1)
        WorkflowRegistry.jsx WorkflowDetail.jsx      # workflows (P1)
        SkillRegistry.jsx                            # skills (P1)
        CopyButton.jsx                               # copy rel/abs path + invocation
        OperationsPanel.jsx CommandPreview.jsx       # operations (P2)
        AuditLog.jsx                                 # audit (P3)
  apps/                   # (lazy) future built apps; each apps/<name>/dist mounted
```

`node_modules/`, `dashboard/dist/`, `apps/*/dist/`, `platform/logs/` → `.gitignore`.

## Backend — `platform/server`

Repo root resolved once in `paths.js` (= `path.resolve(__dirname,'../../..')`). **Every
client-supplied path** is normalized through `paths.safeResolve()`: reject `..`, absolute
paths, and anything outside repo root; restrict reads to `wiki/ raw/ templates/ dashboards/
.claude/skills/ AGENTS.md`. No arbitrary filesystem access from the browser.

`config.js` is the single source for tunable thresholds/limits (kept separate because
workflow staleness differs from memory-lint health):
`LINT_STALE_DAYS = 7`, `WORKFLOW_STALE_DAYS = 90`, `RECENT_ACTIVITY_LIMIT = 6`,
`DRAFT_LIMIT = 6`, `PORT = 3001`, `HOST = '127.0.0.1'`, `EXPOSE_RAW = true`,
`REFRESH_MS = 30000`. `metrics.js` reads `LINT_STALE_DAYS`/limits from here instead of
inlining `STALE_DAYS=7`.

**Bind & exposure invariants (ADR-0005).** The server calls `listen(PORT, HOST)` and
defaults to loopback (`127.0.0.1`). If `HOST` is **not** loopback (`127.0.0.1` / `localhost`
/ `::1`) and no auth layer is configured, the server **refuses to start** — non-localhost
without auth is invalid configuration, not a "recommended later" reminder. `EXPOSE_RAW`
gates `raw/` content (the candid/unreviewed tier) through the read APIs; it defaults `true`
only on loopback. If non-loopback hosting is ever enabled, `raw/` defaults to hidden unless
auth **and** explicit `EXPOSE_RAW=true` are both set.

### APIs
- `GET /api/metrics` — ports the exact definitions from `dashboards/aos-hud.js`:
  - `skip` basenames `index|log|_template|README`, drop `.gitkeep`.
  - `wikiN`, `rawN`, `all` (wiki+raw+templates+dashboards minus `_template`), `examples`,
    `projects` (`wiki/projects`), `workflows` (`wiki/workflows` non-example), `rawProj`,
    `rawFlow`.
  - **captures** (raw files under `examples/`): approved iff body matches the HUD regex
    `^[ \t]*status[ \t]*:[ \t]*(?:\r?\n[ \t]*)*(?:[-*][ \t]*)?([a-z]+)` === `approved`.
    Emit `capN/draftN/apprN` + `drafts[]` (newest by mtime, top 6).
  - **30-day "Repository file growth"** `series[30]` by `pathAddedDate` (Git first saw the
    path). **This is file growth, NOT knowledge accumulation** — promotion raw→wiki adds a
    new path on the promotion date even though the knowledge is older, and Git rename
    detection is unreliable, so `pathAddedDate` ≠ knowledge creation (ADR-0003). Do not
    label this chart "knowledge growth". TODO: true knowledge-intake growth needs lineage
    metadata (frontmatter `created` / `source_id` / `promoted_from`, or an ingest log).
    **7-day** `week[7]` by mtime,
    `weekTotal`, `activeDays`; **recent** top 6 by mtime; **health**: first
    `^##\s*\[(\d{4}-\d{2}-\d{2})\]\s+lint\s*\|` in `wiki/log.md`, `STALE_DAYS=7`,
    `lastLint/lintAge/healthStale/ageLabel`; helpers `target(v)=max(5,ceil((v+1)/5)*5)`,
    `trend`.
  - **Timestamps**: mtime from `fs.stat().mtimeMs`; creation from `gitdates.js` (one
    `git log --diff-filter=A --name-only --format=%aI` pass → path→earliest-add map; fall
    back to `birthtimeMs`/`mtimeMs` — WSL `birthtime` is unreliable).
- `GET /api/docs/tree` — directory tree for `AGENTS.md`, `wiki/`, `raw/`, `templates/`,
  `dashboards/`, `.claude/skills/` (folders + `.md` files), each node **tagged with a
  `source` kind** (`wiki` / `raw` / `template` / `dashboard` / `skill` / `root`) so the UI
  can visually distinguish polished docs from messy raw captures.
- `GET /api/docs/file?path=` — raw markdown + parsed frontmatter (gray-matter) + the file's
  resolved relative & absolute paths (for copy actions).
- `GET /api/docs/search?q=` — filename + content matches across the doc roots.
- `GET /api/docs/backlinks?path=` — other docs that link to this path (resolving the link
  forms below).
- `GET /api/workflows` — registry + per-workflow checks (below). **Per-workflow lookups
  use `GET /api/workflow?path=<safe-relative-path>`** (query param, not `/:id`), since
  workflow paths contain slashes (e.g. `wiki/workflows/evals/cases/...`).
- `GET /api/skills` — scan `.claude/skills/*/SKILL.md`: name, description (frontmatter or
  first line), path, mtime, related workflow guess, invocation `/name`.
- `GET /api/operations` — static catalog of operations + their checklist/command text.
  Each operation is typed **Guided** (checklist + command-preview only; no mutation, no
  shell, no Claude) or **Executable** (deterministic allowlisted local code only). LLM
  Skills (`/ingest`, `/query-memory`, `/capture-approved-example`, `/promote-draft-memory`,
  `/wiki-lint`) can **only** be Guided Operations — the console never claims to execute them
  (ADR-0001).
- `POST /api/operations/:id/dry-run`, `POST /api/operations/:id/run` — **Phase 3 only**,
  executable-allowlist only; until then return `501 not-implemented`.
- `GET /api/audit` — tail `platform/logs/operations.log`.

### Workflow completeness checks (`workflows.js`)
**Registry inclusion — real workflow docs only.** Scan `wiki/workflows/*.md` and `*/*.md`,
but **exclude data/example/result folders by default**: `wiki/workflows/**/examples/**`,
`wiki/workflows/**/cases/**`, `wiki/workflows/**/results/**` (so `evals/cases/*`,
`evals/results/*`, task-mode examples, german-email examples never get status verdicts —
they appear as related data under their parent workflow). Matches the `non-example` rule the
metrics already use.

For each workflow: name, path, `workflow_kind` (frontmatter:
`runbook | reference | style-guide | policy | inventory | eval-suite`), last modified, plus
checks parsed from the file + `wiki/index.md` + `wiki/agentic-os-usage.md`. **`workflow_kind`
selects which checks are required**; `checks_exempt` (frontmatter list) opts a workflow out
of a check that legitimately doesn't apply (a style-guide like `german-technical-emails` is
not held to a runbook's shape).

**Status-impacting checks (objective defects only):**
- linked from `index.md`? · broken/unsafe metadata? · open TODO/FIXME/open questions
  (unless explicitly marked accepted/standing)? · missing verification — **only** for kinds
  where verification is expected (runbook/executable). "Verification: not applicable" is an
  explicit decision, shown as-is, **never** flagged missing.

**Informational-only checks (surfaced, never turn the row yellow):**
- has `examples/`? · defines a "when to use" section? · a related `.claude/skills/` skill
  exists? · referenced from `agentic-os-usage.md`? (unless the kind requires it)

- **Status roll-up — first match wins, precedence `Missing links > Needs review > Stale >
  OK`:**
  - `Missing links` — not indexed in `index.md`, or not referenced where the kind requires.
  - `Needs review` — broken/unsafe metadata, or unaccepted TODO/FIXME/open questions, or
    missing verification for a kind that expects it.
  - `Stale` — structurally valid (all objective checks pass) but `mtime` older than
    `WORKFLOW_STALE_DAYS` (config).
  - `OK` — all required checks pass.
- **Principle:** the registry is a discovery + quality signal, **not a ceremony enforcer** —
  flag objective defects; surface editorial niceties separately so real problems don't drown
  in false warnings (ADR-0006).
Also surface the doc-gap checks GPT flagged, computed honestly from the files:
session-close step present, 7-day cadence present, `/promote-draft-memory` cited in
`agentic-os-usage.md`, `manual-operations.md` links the relevant skills, task-modes
indexed.

### Live reads / caching
Phase 1 uses **live filesystem reads**. The only expensive part is the per-request
`git log --diff-filter=A` pass in `gitdates.js`; plain `fs.stat` scans over ~90 files are
negligible and stay live. An **optional in-memory TTL cache** is allowed **only** for the
expensive aggregate endpoints (`/api/metrics`, `/api/workflows`) — short TTL (~5–30s, ≤
`REFRESH_MS`) so the 30s poll doesn't re-run `git log` twice a minute for an idle tab. The
manual **Refresh** button **bypasses the cache** (e.g. `?fresh=1`) so a change you just made
(e.g. an ingest) is visible immediately — refresh must never be a no-op. **Individual doc
reads (`/api/docs/file`) stay live.** No persistent cache, no file watcher, no background
indexer.

### Static hosting / platform hook
Serve `dashboard/dist` at `/` in prod. On boot, scan `platform/apps/*/dist` and
`express.static`-mount each at `/apps/<name>` — the extension point for the user's future
**built React/Angular/Vite frontends** (static `dist/` only). **This does not host
Node/Nest backend processes** (no spawn/supervise/port/proxy/health/lifecycle); that is a
separate deferred "local app supervisor" product with its own security review (ADR-0004).
Single port (`PORT`, default `3001`), bound to `HOST` (loopback by default).

## Frontend — `platform/dashboard` (React + Vite, Odysseus style)

`theme.css` tokens distilled from the reference image:
`--bg:#15181d`, `--panel:#1d222a`, `--panel-2:#222831`, `--line:#2a313b`,
`--text:#cdd3da`, `--dim:#8b93a0`, `--muted:#5f6772`, `--accent:#e08a8a`,
`--accent-2:#ec9a9a`, `--green:#6ec07a` (status dot), + blue/yellow/purple for integration
dots. Monospace stack (JetBrains Mono / IBM Plex Mono / SFMono / Menlo / Consolas);
uppercase letter-spaced labels; ~10px radii; 1px `--line` borders; glowing status dots
(`box-shadow:0 0 8px currentColor`). Coral peak/brand mark like Odysseus's `⌃` logo.

**Sidebar** (Odysseus left nav, lucide icons, inline status chips like Odysseus's
`idle ●`): Overview · Documentation · Workflows · Skills · Review Queue · Memory Health ·
Activity · Operations · Audit Log · Platform Apps · Settings. The `HEALTH · DUE` and
`N DRAFT` chips turn coral when stale / drafts > 0.

**Sections / components:**
- **Overview** — `RepoHealth` (one diagnostic card: Docs OK/Needs-review · Workflows
  `N OK / N needs review` · Skills `N found` · Draft captures `N` · Lint age `N days` ·
  Obsidian HUD parity `unchecked`), then `Hero` (coral peak + "Agentic OS", subtitle,
  `READY · <ts>`, an Odysseus-style command bar listing the **five real skills**
  `/ingest /query-memory /wiki-lint /capture-approved-example /promote-draft-memory`),
  `StatCards` (3 gauge cards, 26-segment gauge + `target()`), `GrowthChart` (port the HUD
  SVG, recolored coral), `HealthPanel`, `ReviewQueue`, `RecentActivity`, `WeekBars`,
  `Integrations`.
- **Documentation** — `DocsExplorer` file tree (AGENTS.md, wiki/, raw/, templates/,
  dashboards/, .claude/skills/), **grouped/badged by source kind** — Wiki, Raw, Templates,
  Dashboards, Skills — so messy raw captures read differently from polished wiki docs.
  `MarkdownViewer` (react-markdown + remark-gfm: headings, code, lists, frontmatter) with a
  right-side TOC + backlinks. **Link handling via a custom `a` renderer** resolves and
  rewrites to internal navigation:
  - relative links (`../workflows/manual-operations.md`) — resolved against current dir.
  - root-relative repo links (`wiki/workflows/manual-operations.md`).
  - Obsidian wikilinks (`[[manual-operations]]`, including `[[page#heading]]`) — matched to
    a doc by basename via a remark step.
  - heading anchors (`manual-operations.md#session-close` and bare `#section`) — scroll to
    the slugged heading.
  - external `http(s)` links open in a new tab; unresolved targets render disabled.
- **Workflows** — `WorkflowRegistry` table (per-workflow check columns + status) →
  `WorkflowDetail` (open file, show failing checks).
- **Skills** — `SkillRegistry`: the five repo skills with description, path, related
  workflow, mtime, copy-invocation, open-file.

Every doc / workflow / skill page exposes a `CopyButton` cluster — **Copy relative path**,
**Copy absolute path**, **Copy open command** (e.g. `code <abs>`) via the clipboard API. No
`file://` links (unreliable across browsers/WSL) unless the user later confirms behavior.
- **Operations** (P2) — `OperationsPanel` of guided flows (session-start, task-mode
  picker, pre/post-edit checklists, memory-update, draft-review, wiki-lint, session-close)
  rendered as checklists + `CommandPreview` (exact command, copy button — **no run** yet).
- **Audit Log** (P3) — `AuditLog` reads `/api/audit`.
- **Platform Apps** — lists mounted `/apps/<name>`. **Settings** — port, refresh interval,
  theme note.

`App.jsx` fetches the relevant API per section, with a manual refresh + optional 30s poll.
`vite.config.js` proxies `/api` → `:3001` in dev; builds to `dist/`.

## Action safety model (applies the moment any write/exec lands — Phase 3)
- Browser can never run arbitrary shell. Only an **allowlist** of named **Executable
  Operations** (deterministic local code; no LLM judgment, no headless Claude).
- Every write/exec: **dry-run first**, explicit **confirm**, then run.
- Show `stdout`/`stderr`, changed files, and `git diff` before final apply where relevant.
- Append an audit entry (op, ts, status, files, output) to `platform/logs/operations.log`.
- **Executable allowlist (wired only in P3) — deterministic checks/scripts only:**
  `npm run verify`, `check:paths`, `check:docs`, `check:workflows`, `check:skills`,
  `check:metrics-parity`. No generic terminal.
- **NOT executable.** LLM Skills (`/ingest`, `/promote-draft-memory`,
  `/capture-approved-example`, `/query-memory`) are removed from the allowlist — they need
  LLM judgment and remain **Guided Operations** only. `/wiki-lint` (LLM, guided) is split
  from a future deterministic `check:wiki-structure` (executable). No pretending a Claude
  skill is an npm script (ADR-0001).

## Phasing
- **Phase 1 — read-only console:** metrics + health + review + activity + Odysseus shell,
  Docs explorer/search/backlinks, Workflow registry+checks, Skill registry. (Ship target.)
- **Phase 2 — guided operations:** checklists + command previews (copy, no execution).
- **Phase 3 — controlled execution:** allowlist + dry-run + confirm + diff + audit.

## Docs
Add a short pointer to `AGENTS.md` "Obsidian dashboard" section: a live **web console** now
lives under `platform/` (Express + React, Odysseus style) and is the **canonical** memory
metrics implementation; it reads metrics live and browses/checks docs, workflows, and
skills. It is a **localhost-only private console** (not safe for LAN/public exposure without
auth). The **Obsidian HUD is being migrated off and deprecated** — once the console is
trusted, mark `dashboards/Agentic OS Dashboard.md` and `dashboards/aos-hud.js` deprecated
(visible notice only thereafter) and remove any "both dashboards are authoritative" wording
(ADR-0002). Detail lives in `platform/README.md` (static-context rule: AGENTS.md gets a
pointer only).

## Verification

Performed during implementation:
1. `cd platform && npm install` completes; `npm run build` succeeds; `npm start` serves
   UI + API on `:3001`; `npm run dev` hot-reloads with `/api` proxy.
2. `curl -s localhost:3001/api/metrics | jq` returns the documented fields.
3. **Metric parity (temporary migration gate)** vs the Obsidian HUD: `wikiN` =
   `find wiki -name '*.md'` minus index/log/_template/README; `rawN` likewise;
   `healthStale`/`lintAge` match the top `lint` entry date in `wiki/log.md`. This validates
   migration to the canonical console — it is **not** a permanent two-runtime invariant and
   is retired/relaxed once the HUD is deprecated (ADR-0002).
4. **Docs**: tree loads `AGENTS.md`, `wiki/index.md`, `wiki/log.md`,
   `wiki/agentic-os-usage.md`, `wiki/workflows/`; viewer renders headings/code/lists/
   links/frontmatter; search finds `ingest`, `query-memory`, `wiki-lint`,
   `manual-operations`, `task-modes`, `promote-draft-memory`.
5. **Workflow registry** lists real workflow docs (excludes `**/{examples,cases,results}/**`)
   and flags **objective defects** (missing index link / unaccepted TODO / missing
   verification where the kind expects it) — while editorial niceties (examples, when-to-use)
   stay informational and a `checks_exempt` / "verification: not applicable" workflow does
   **not** show yellow. Spot-checked against `german-technical-emails` (style-guide kind:
   stays OK) and a runbook.
6. **Skill registry** finds exactly the five `.claude/skills/*` skills — and does **not**
   invent `/bw2-update-memory`.
7. **Safety**: no arbitrary-shell endpoint exists; `POST /api/operations/*` returns 501
   until P3; path traversal (`..`, absolute) is rejected by `paths.safeResolve`.
   **Loopback bind**: server is bound to `127.0.0.1` only (not `0.0.0.0`); a non-loopback
   `HOST` without configured auth **fails startup**; `raw/` exposure follows `EXPOSE_RAW`
   (default true only on loopback) (ADR-0005).
8. Existing Obsidian dashboard (`dashboards/`) is byte-for-byte unchanged and still opens
   in Obsidian (it is now a deprecation target, not an actively maintained peer).

A lightweight **`npm run verify`** script (`platform/scripts/verify.mjs`, added in P1)
boots the server and asserts: server bound to loopback (`127.0.0.1`) only; non-loopback
`HOST` without auth fails startup; `/api/metrics` responds; `/api/docs/tree` responds;
`/api/skills` returns exactly 5; path traversal (`?path=../../etc`) is rejected; `raw/`
exposure follows `EXPOSE_RAW`; `POST /api/operations/:id/run` returns 501 before P3; and
`npm run build` succeeds. It prints pass/fail per check and exits non-zero on any failure
(CI-ready, but run manually for now to fit the repo's "not yet automated" stage).

Recommended (human): visual fidelity pass against the Odysseus reference; decide whether/
when to enable Phase 3 execution; design auth before *any* non-localhost hosting (note:
non-loopback without auth is a hard startup failure, not a soft reminder); backfill
`workflow_kind` frontmatter into existing `wiki/workflows/*.md`.
