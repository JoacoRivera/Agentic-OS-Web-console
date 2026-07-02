# Agentic OS

The ubiquitous language for the Agentic OS repo: a Markdown memory wiki (`raw/` → `wiki/`)
operated by an LLM harness, plus the tooling and consoles built around it.

## Language

### Memory model

**Wiki**:
The polished, verified long-term memory under `wiki/`. The canonical, synthesized,
**published** tier — its count (`wikiN`) is the headline "Published memory" stat.
_Avoid_: docs (too generic), knowledge base

**Raw capture**:
An unverified source file under `raw/`. May be a draft, a project snapshot, or notes.
`raw/` is **append-only evidence/archive**: promotion *copies* a capture into `wiki/` and
**keeps** the raw original, so `rawN` only ever grows — it is a source archive, **not** a
backlog that drains. `raw/` and `wiki/` are two independent monotonic stores, not stages of
a pipeline; there is no raw→wiki funnel.
_Avoid_: note, doc, treating rawN as unprocessed backlog, raw→wiki burndown framing

### Metrics

**Canonical metrics implementation**:
The single source of truth for memory metrics — the **web console** (`platform/server`).
The Obsidian HUD (`dashboards/`) is a **migration reference only**, not a long-term peer;
it is deprecated once the web console is trusted.
_Avoid_: "both dashboards are authoritative" (false), HUD-as-source-of-truth

**check:metrics-groundtruth**:
The **permanent** executable check that compares `/api/metrics` against an *independent
filesystem recount* (the same skip/count rules, recomputed directly). The filesystem is the
permanent source of truth, so this check is permanent and in the Phase-3 allowlist. It must
**not** depend on `dashboards/aos-hud.js`. (Renamed from the old `check:metrics-parity`,
which conflated ground-truth correctness with HUD migration — ADR-0002.)
_Avoid_: check:metrics-parity (conflated name), making it depend on the HUD

**check:hud-parity**:
The **temporary migration gate** comparing the web console against the Obsidian HUD *during
migration only*. The HUD is a migration **oracle**, not a peer. Outside the permanent
allowlist (or flagged `migrationOnly: true`). Retired by an explicit human HUD-deprecation
sign-off once `check:metrics-groundtruth` is green and the console is canonical (ADR-0002).
_Avoid_: treating HUD parity as a permanent invariant or putting it in the permanent allowlist

### Memory lineage dates

Three distinct dates — never collapse them into one ambiguous "creation".

**knowledgeIntakeDate**:
When knowledge first entered Agentic OS — usually the raw capture date. The semantic
"memory was created" date. Requires lineage metadata to compute reliably; not derivable
from Git path history.
_Avoid_: "creation date" (ambiguous), created

**wikiPublishDate**:
When a polished `wiki/` doc was created or promoted. Promotion (raw → wiki) is **publishing,
not new intake** — it sets `wikiPublishDate`, not a new `knowledgeIntakeDate`.
_Avoid_: creation date

**pathAddedDate**:
When Git first saw the current file path (`git log --diff-filter=A`). A purely mechanical
fact about the filesystem path, **not** memory creation. Only valid for a chart labeled
"file growth".
_Avoid_: creation date, knowledge creation

### Security boundaries

**Loopback-only console**:
Phase 1 is a **localhost-only private console**. Default `HOST=127.0.0.1`; the server
`listen(PORT, HOST)`. It is **not** safe for LAN/public exposure without auth.
_Avoid_: treating it as a hostable/shared service

**Sensitive read APIs**:
`/api/docs/file` and `/api/docs/search` expose raw `wiki/` and `raw/` memory **contents**
(not just metrics). They are sensitive by definition. `raw/` is candid/unreviewed memory and
may hold NDA-grade client material — treat as sensitive. `raw/` **content** exposure is gated
by `EXPOSE_RAW_CONTENT` (default **false**); raw *metrics* (counts/dates/health) are always
computed internally regardless. Loopback bind alone is insufficient — the API also enforces
Host/Origin checks against DNS rebinding (ADR-0005).
_Avoid_: assuming path-safety or loopback alone makes these endpoints safe to expose;
conflating raw metrics with raw content exposure

**EXPOSE_RAW_CONTENT**:
The single opt-in flag that gates raw **content** over HTTP (`/api/docs/file` for `raw/**`,
raw bodies/snippets in search, raw markdown preview). Default `false`. It gates content only,
never metrics. (Renamed from `EXPOSE_RAW` to remove the metrics-vs-content ambiguity.)
_Avoid_: EXPOSE_RAW (ambiguous — sounds like it gates raw metrics too)

## Principles

**Path creation is not memory creation. Promotion is publishing, not new intake.**
The growth chart measures whatever date it actually has — `pathAddedDate` today, so it is
a "file growth" chart, not a "knowledge accumulation" chart, until lineage metadata exists.

**Path safety prevents reading *outside* the allowed roots. It does not make the allowed
roots safe to *expose*.** Loopback bind and auth-gating are mandatory safety boundaries,
not recommendations. Non-localhost without auth is *invalid configuration* — the server
must refuse to start.

### Things the user can act on

These three are deliberately distinct concepts and must not be conflated in any UI or tool.

**Skill**:
An LLM-facing capability/instruction pack from `.claude/skills/*/SKILL.md`. Invoked by
Claude, requires LLM judgment. **Not executable by the console** — the console may only
*describe* a skill or guide a human through invoking it. The five repo skills: `/ingest`,
`/query-memory`, `/wiki-lint`, `/capture-approved-example`, `/promote-draft-memory`.
_Avoid_: command, operation, tool

**Workflow**:
A documented operating procedure / runbook from `wiki/workflows/*.md`. A human- or
LLM-followed procedure, **not executable by the console**. Each has a `workflow_kind`
(below) that determines which completeness checks apply.
_Avoid_: operation, runbook (use "Workflow"), process

**workflow_kind**:
The type of a workflow, declared in frontmatter, selecting its required checks:
`runbook | reference | style-guide | policy | inventory | eval-suite`. A style-guide (e.g.
`german-technical-emails`) is not held to a runbook's shape. **There is no default kind** —
absence is not "assume `reference`". A file with no `workflow_kind` is **Unclassified**
(below); the kind is never inferred from title, tags, or filename (ADR-0007).
_Avoid_: one-size-fits-all workflow shape, inferring the kind, defaulting to reference

**Unclassified**:
The Workflow Registry status of a workflow that has no `workflow_kind` frontmatter: the
console **cannot judge** its kind-dependent checks, so it is neither `OK` nor a defect color.
Kind-*independent* objective defects (e.g. not linked from `index.md`) still apply and
out-rank it; a structurally clean but un-annotated file shows `Unclassified`, never `OK`
(ADR-0007). The console may *suggest* a likely kind but status logic must not act on the
suggestion.
_Avoid_: defaulting unclassified rows to OK or to reference

**Objective defect vs. editorial nicety**:
A registry **status-impacting** check flags a genuine defect (not indexed in `index.md`;
broken/unsafe metadata; unaccepted TODO/FIXME; missing verification *only* where the kind
expects it — where "verification" means a **stated method for validating/running** the
workflow, e.g. a `## Verification`, "Manual run checklist", or "Result recording" section,
**not** a magic heading; an explicit "Verification: not applicable" satisfies it). An **informational-only** check surfaces editorial metadata (has examples /
"when to use" / related skill) without turning the row yellow. `checks_exempt` in
frontmatter opts a workflow out of a check that legitimately doesn't apply.
_Avoid_: treating editorial niceties as defects

**Operation**:
A console-facing **action card** — a separate UI/runtime concept that *may reference* a
skill or workflow but is neither. Two strict subtypes:
- **Guided Operation**: checklist + command-preview only. No mutation, no shell, no Claude
  invocation. (e.g. session-start, draft-review.)
- **Executable Operation**: deterministic, allowlisted local code only. No LLM judgment,
  no arbitrary shell, no headless Claude. (e.g. `npm run check:paths`.)
_Avoid_: command, action (use "Operation"), task

### Hosting

**Platform Apps (static hosting)**:
Scanning `platform/apps/*/dist` and `express.static`-mounting each at `/apps/<name>`. Serves
**built frontends only** (React/Angular/Vite `dist/`). "Host" here means *serve static
builds*. **Deferred out of P1** (ADR-0004): same-origin hosting would grant a hosted bundle
ambient read access to `/api/*`, bypassing the ADR-0005 Origin defense. When it returns it
must be **separate-origin** with explicit per-app API grants.
_Avoid_: PaaS, app hosting (implies backends), deploy, treating it as a P1 feature

**Local app supervisor**:
The deferred, separately-scoped future product that would run live **backend** services
(Nest/Node) — requiring a process model (spawn/supervise/restart, env, ports, reverse
proxy, logs, health, security boundaries). **Explicitly out of scope** for the memory
console and not bundled into it; needs its own design + security review.
_Avoid_: conflating with Platform Apps / the memory console

## Notes

- A console Operation that maps onto an LLM Skill (ingest, promote-draft, capture-example,
  query-memory) can only ever be a **Guided Operation**. It must never claim to *execute*
  the skill.
- `/wiki-lint` (LLM skill) is split from a future deterministic `check:wiki-structure`
  Executable Operation — same intent, different runtime, different concept.
