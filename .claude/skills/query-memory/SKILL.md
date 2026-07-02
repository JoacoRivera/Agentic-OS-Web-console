---
name: query-memory
description: Recall Agentic OS long-term memory before doing work in this repo. Use before designing, implementing, or deciding anything about the web console — to answer "what does Agentic OS already know about this?". Read-only.
---

# Query Memory Skill (web-console bridge)

Use this skill to recall relevant long-term memory **before** doing work in the
`agentic-os-web-console` repo. It is the recall half of the memory loop, run from
the working repo. It reads two sources and never edits anything.

This is the bridge variant of the Agentic OS `query-memory` skill, tuned for this
project. If anything here conflicts with the memory repo's `AGENTS.md`, follow
`AGENTS.md`.

## Two sources to recall from

1. **This repo's own domain docs** — the authoritative, in-tree source for the
   console's ubiquitous language and binding decisions. Read first:
   - `docs/CONTEXT.md` — the glossary (Skill / Workflow / Operation, the three
     distinct dates). Terms here are load-bearing; use them precisely.
   - `docs/adr/0001..0006` — the accepted architecture decisions (binding
     invariants). Read the ADRs that touch the area you're about to work in.
   - `docs/plans/odysseus-web-console-2026-06-29.md` — the implementation plan.

2. **The external Agentic OS wiki** at `~/agents/agentic-os` — the synthesized
   long-term memory the console is built around. Relevant locations:
   - `wiki/projects/agentic-os-web-console.md` — the project memory page. **Read
     this first** of the external sources; it summarizes the six decisions and
     open questions.
   - `wiki/index.md` — the catalog, to locate other relevant pages.
   - `wiki/log.md` — recent changes and chronology.
   - `wiki/workflows/` — the harness procedures the console describes
     (`manual-operations`, `task-modes`, `verification`, etc.).
   - `wiki/projects/`, other `wiki/` pages — for broader domain memory.

   Do not treat `skills/` as memory. Skills are prompt workflows, not facts.

## Rules

- **Read-only.** Do not edit any file in this repo or in `~/agents/agentic-os`.
- Do not read or modify `~/agents/agentic-os/raw/` unless the user asks for
  source-level traceability — prefer the polished `wiki/`.
- Prefer `docs/CONTEXT.md` + `docs/adr/` (in-repo) and
  `wiki/projects/agentic-os-web-console.md` (external) before broad searching.
- Do not invent missing details. If memory is absent or incomplete, say so.
- Distinguish confirmed memory from open questions; report contradictions.
- If the in-repo docs and the external wiki disagree, flag it — the in-repo
  `docs/adr/` are the binding source for the console; surface the conflict for
  reconciliation rather than silently picking one.
- If the answer reveals durable knowledge not yet captured, recommend a capture
  (see `capture-approved-example`) — but do not perform it here.

## Workflow

1. Read the relevant `docs/CONTEXT.md` / `docs/adr/` / plan sections in this repo.
2. Read `~/agents/agentic-os/wiki/projects/agentic-os-web-console.md`.
3. Use `~/agents/agentic-os/wiki/index.md` to locate any other relevant pages and
   read them.
4. Optionally inspect `~/agents/agentic-os/wiki/log.md` for recent changes.
5. Synthesize the answer from these sources.
6. Note missing details, open questions, and any in-repo vs. external conflicts.
7. Suggest whether a new capture should be created.

## Output format

```markdown
## Memory query result

### Relevant sources
- (in-repo docs and external wiki pages actually read)

### What memory says
-

### Open questions / missing details
-

### Conflicts (in-repo docs vs. external wiki, or internal)
-

### Suggested next action
-
```
