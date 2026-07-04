# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

This is a **design/planning-stage repo**. There is **no application code yet** — `backend/`
and `frontend/` are empty placeholders, and there is no `package.json`, build, lint, or test
setup. The substance lives entirely in `docs/`:

- `docs/CONTEXT.md` — the **ubiquitous language** (domain glossary + principles). Read this
  first; the terms below are load-bearing and must be used precisely.
- `docs/plans/odysseus-web-console-2026-06-29.md` — the full implementation plan (target
  layout, APIs, components, phasing, verification).
- `docs/adr/0001..0006` — accepted architecture decisions. These are **binding invariants**,
  not suggestions.

When implementing, the plan specifies a new top-level **`platform/`** directory (npm
workspaces: `server` = Express, `dashboard` = React+Vite) — *not* the existing empty
`backend/`/`frontend/` dirs. Follow the plan's `Target layout` section. The intended commands
(once `platform/` exists) are `npm install`, `npm run dev`, `npm run build`, `npm start`, and
`npm run verify` (a smoke-check script in `platform/scripts/verify.mjs`).

## What this project is

A **localhost-only web console** for the "Agentic OS" — a separate repo that is a Markdown
memory wiki (`raw/` captures → polished `wiki/`) operated by an LLM harness. This console
reads that repo's filesystem **live** to surface memory metrics, browse docs, and check
workflow/skill completeness. It becomes the **canonical** metrics implementation, replacing
the existing Obsidian HUD (`dashboards/aos-hud.js`), which is being deprecated (ADR-0002).

The console runs at `platform/` *inside the Agentic OS repo*; repo root resolves to
`../../..` from `platform/server/src/paths.js`.

## Hard invariants (do not violate)

These come from the ADRs and `CONTEXT.md`. Breaking one is a regression even if tests pass.

1. **The console never executes LLM Skills** (ADR-0001). The five repo Skills (`/ingest`,
   `/query-memory`, `/wiki-lint`, `/capture-approved-example`, `/promote-draft-memory`) need
   LLM judgment and can only ever be **Guided Operations** (checklist + command preview). Do
   not shell out to headless Claude or pretend a Skill is an npm script. The Phase-3
   executable allowlist contains **only** deterministic checks (`npm run verify`,
   `check:paths`, `check:docs`, `check:workflows`, `check:skills`, `check:metrics-groundtruth`).
   `check:hud-parity` is a **temporary** migration gate, **not** in the permanent allowlist
   (flag `migrationOnly: true` if co-located); the permanent allowlist must not depend on
   `dashboards/aos-hud.js` (ADR-0001/0002).

2. **Loopback bind + Host/Origin defense + auth-gating are mandatory** (ADR-0005). Server
   defaults to `HOST=127.0.0.1` and calls `listen(PORT, HOST)`. A non-loopback `HOST` without
   configured auth must **refuse to start** — it is invalid config, not a "add auth later"
   reminder. **Loopback bind is necessary but insufficient:** the API also validates the
   `Host` header against loopback hosts and rejects cross-origin `Origin`s (DNS-rebinding
   defense, no permissive CORS) — protecting `wiki/` and `raw/` alike. The read APIs
   (`/api/docs/file`, `/api/docs/search`) expose raw memory *contents*; `raw/` is the
   candid/unreviewed tier (already holds NDA-grade client material). Raw **content** exposure
   is gated by `EXPOSE_RAW_CONTENT` (default **`false`**); raw **metrics** are always computed
   internally. **Path safety (`paths.safeResolve` rejecting `..`/absolute/outside-root)
   prevents reading outside allowed roots; it does NOT make those roots safe to expose** —
   these are two different problems.

3. **The growth chart measures file growth, not knowledge** (ADR-0003). It is keyed on
   `pathAddedDate` (when Git first saw the path via `git log --diff-filter=A`). Label it
   "Repository file growth", never "knowledge accumulation". Three dates are deliberately
   distinct and must never be collapsed: `knowledgeIntakeDate`, `wikiPublishDate`,
   `pathAddedDate` (only the last is computable today). Promotion raw→wiki is *publishing*,
   not new intake.

4. **"Platform Apps" is static frontend hosting only — and is deferred out of P1** (ADR-0004).
   When it exists it scans `platform/apps/*/dist` and `express.static`-mounts each, serving
   built React/Angular/Vite `dist/` only — it does **not** spawn/supervise Node/Nest backend
   processes (that is a separate deferred "local app supervisor" product). **It is not in P1**:
   same-origin hosting would grant any hosted bundle ambient read access to `/api/*`,
   bypassing the ADR-0005 Origin defense (a hosted bundle + its npm supply chain could read
   and exfiltrate memory). When it returns it must be **separate-origin** (distinct port/host,
   API denies app origins by default, explicit per-app CORS/token grants).

5. **WorkflowRegistry status is driven by objective defects only** (ADR-0006). Required
   checks are selected per workflow by a frontmatter `workflow_kind`
   (`runbook | reference | style-guide | policy | inventory | eval-suite`), with
   `checks_exempt` to opt out. Editorial niceties (has examples, "when to use", related
   skill) are **informational-only** and never turn a row yellow. Exclude
   `wiki/workflows/**/{examples,cases,results}/**` from the registry. **There is no default
   `workflow_kind`** — an un-annotated workflow is `Unclassified`, never assumed `reference`
   (ADR-0007); `workflow_kind` maps to two booleans (`requires_verification`,
   `requires_runbook_shape`), and in P1 only `runbook`/`eval-suite` are status-distinct.
   Status precedence (first match wins): `Missing links` > `Needs review` > `Unclassified` >
   `Stale` > `OK`. Classifying the ten existing workflows is P1 DoD. The registry is a
   discovery/quality signal, not a ceremony enforcer.

## Domain language (use these exact terms)

Three deliberately distinct, non-interchangeable concepts (`CONTEXT.md`):

- **Skill** — an LLM-facing capability pack from `.claude/skills/*/SKILL.md`. Invoked by
  Claude; not console-executable. There are exactly **five** (above); the registry scans the
  directory — never hardcode a phantom Skill (e.g. `/bw2-update-memory` does not exist).
- **Workflow** — a documented runbook/procedure from `wiki/workflows/*.md`, followed by a
  human or LLM; not console-executable. Has a `workflow_kind`.
- **Operation** — a console-facing **action card**. Two strict subtypes: **Guided** (checklist
  + command preview; no mutation/shell/Claude) and **Executable** (deterministic allowlisted
  local code; Phase 3 only). An Operation may *reference* a Skill/Workflow but is neither.

Avoid the words "command"/"tool"/"task"/"runbook" as synonyms for these — the glossary's
`_Avoid_` lists are intentional.

## Phasing

- **Phase 1** (ship target) — read-only console: metrics, health, review queue, Docs
  explorer/search/backlinks, Workflow registry+checks, Skill registry, Odysseus visual shell.
- **Phase 2** — Guided Operations (checklists + command previews, copy, no execution).
- **Phase 3** — controlled execution: executable allowlist + dry-run + confirm + diff +
  audit log. Until Phase 3, `POST /api/operations/:id/run` returns `501`.

## Visual style

"Odysseus" aesthetic: dark slate bg, left sidebar nav, monospace type, muted coral/rose
accent (`~#e08a8a`), small glowing status dots, rounded 1px-bordered panels. Design tokens
go in `platform/dashboard/src/theme.css` (full token list in the plan).

## Documentation convention

`AGENTS.md` (in the Agentic OS repo) follows a **static-context rule**: it gets a *pointer
only* to the console; detailed docs live in `platform/README.md`. Don't duplicate plan-level
detail into `AGENTS.md`.

## Agent skills

### Issue tracker

GitHub Issues via the `gh` CLI; external PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles using their default label names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `docs/CONTEXT.md` + `docs/adr/`, plus the external Agentic OS memory repo at `~/agents/agentic-os` (`AGENTS.md`) as a secondary domain source. See `docs/agents/domain.md`.
