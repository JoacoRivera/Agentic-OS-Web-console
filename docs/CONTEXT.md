# Agentic OS

The ubiquitous language for the Agentic OS repo: a Markdown memory wiki (`raw/` → `wiki/`)
operated by an LLM harness, plus the tooling and consoles built around it.

## Language

### Memory model

**Wiki**:
The polished, verified long-term memory under `wiki/`. The canonical knowledge base.
_Avoid_: docs (too generic), knowledge base

**Raw capture**:
An unverified source file under `raw/`. May be a draft, a project snapshot, or notes,
not yet ingested into the `wiki/`.
_Avoid_: note, doc

### Metrics

**Canonical metrics implementation**:
The single source of truth for memory metrics — the **web console** (`platform/server`).
The Obsidian HUD (`dashboards/`) is a **migration reference only**, not a long-term peer;
it is deprecated once the web console is trusted.
_Avoid_: "both dashboards are authoritative" (false), HUD-as-source-of-truth

**Metrics parity check**:
`check:metrics-parity` — a **temporary migration gate** comparing web-console output
against the existing HUD definitions/expected counts. It exists to validate the migration,
not as a permanent two-runtime guarantee. Retired (or relaxed) once the HUD is deprecated.
_Avoid_: treating parity as a permanent invariant

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
(not just metrics). They are sensitive by definition. `raw/` is candid/unreviewed memory —
treat as sensitive; gated by `EXPOSE_RAW` (default true only on loopback).
_Avoid_: assuming path-safety alone makes these endpoints safe to expose

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
`german-technical-emails`) is not held to a runbook's shape.
_Avoid_: one-size-fits-all workflow shape

**Objective defect vs. editorial nicety**:
A registry **status-impacting** check flags a genuine defect (not indexed in `index.md`;
broken/unsafe metadata; unaccepted TODO/FIXME; missing verification *only* where the kind
expects it). An **informational-only** check surfaces editorial metadata (has examples /
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
The Phase-1 capability: scan `platform/apps/*/dist`, `express.static`-mount each at
`/apps/<name>`. Serves **built frontends only** (React/Angular/Vite `dist/`). "Host" here
means *serve static builds*.
_Avoid_: PaaS, app hosting (implies backends), deploy

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
