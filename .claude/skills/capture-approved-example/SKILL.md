---
name: capture-approved-example
description: Capture an approved result from web-console development into the Agentic OS memory as a raw/ draft. Use after the user approves a decision, implementation pattern, investigation, or fix while building the console, to keep long-term memory updated.
---

# Capture Approved Example Skill (web-console bridge)

Use this skill when the user says a result, decision, implementation pattern,
investigation, or fix produced while building the `agentic-os-web-console` is
approved and should be remembered. It is the **capture half** of the memory loop,
run from this working repo: it writes **one** raw source file into the external
Agentic OS memory as a `Status: Draft`. The downstream `/promote-draft-memory` and
`/ingest` skills — run **inside** `~/agents/agentic-os` — later triage and promote
durable facts into `wiki/`.

This is the bridge variant of the Agentic OS `capture-approved-example` skill,
tuned for this project. If anything here conflicts with the memory repo's
`AGENTS.md`, follow `AGENTS.md`.

## Goal

Create a concise raw source file under the Agentic OS memory's
`raw/projects/agentic-os-web-console/examples/` that preserves the approved
example without dumping transcript noise — suitable for later `/ingest`.

## Rules

- **Write into the memory repo, not this code repo.** All `raw/` paths are under
  the Agentic OS memory root `~/agents/agentic-os`. Never write memory into
  `agentic-os-web-console`.
- Do not edit `~/agents/agentic-os/wiki/` directly.
- Do not modify existing `~/agents/agentic-os/raw/` files. Create a new file only.
- Preserve facts exactly. Do not invent missing dates, owners, paths, files, or
  verification results — leave them blank and record under **Open questions**.
- Do not promote a single example into a general rule.
- Use the project's ubiquitous language from `docs/CONTEXT.md` precisely (keep
  **Skill**, **Workflow**, **Operation** distinct; never collapse the three dates
  `knowledgeIntakeDate` / `wikiPublishDate` / `pathAddedDate`).
- Do not store secrets, passwords, API keys, private keys, tokens, or credentials.
- **Always write `Status: Draft`.** The user flips it to `Approved` after review.
  Never set `Approved` yourself.
- **Never run `/ingest` or `/promote-draft-memory` yourself** — those are
  user-driven steps in the memory repo. After capturing, prompt the user.

## Destination

This project's captures go to:

```text
~/agents/agentic-os/raw/projects/agentic-os-web-console/examples/
```

If that `examples/` directory does not exist yet, create it before writing. Do not
invent a different project slug. (Only deviate if the user explicitly says the
example belongs to a different project/workflow — then confirm the exact `raw/`
path with them, as the canonical capture skill describes.)

## File naming

Lowercase kebab-case, with today's date:

`<topic>-<example-type>-YYYY-MM-DD.md`

Examples:

- `paths-safe-resolve-decision-2026-06-29.md`
- `metrics-parity-port-investigation-2026-06-29.md`
- `loopback-bind-guard-implementation-2026-06-29.md`

If a file with the same name exists, do not overwrite — append a short
disambiguating suffix (e.g. `-2`).

## Output file structure

Every capture carries a `Status: Draft` line in its header block. Use this
body shape for console-development examples:

```markdown
# <Title>

Date:
Example type:
Project: agentic-os-web-console
Source:
Status: Draft
Approved by:

## Task

## Context

## Skills/workflows used

## Decision / change made

## Why (rationale, ADRs or invariants it rests on)

## Verification

## Reusable lesson

## Do not generalize

## Open questions
```

For an approved *decision* (e.g. a new architectural choice), note in **Why**
whether it confirms, extends, or contradicts an existing ADR in `docs/adr/` so the
downstream triage can reconcile it.

## Steps

1. Confirm with the user **what** is being captured and that it is approved.
2. Pick the file name and ensure the destination `examples/` directory exists.
3. Fill the header block — leave unknown fields blank and record them under
   **Open questions** rather than guessing. Always write `Status: Draft`.
4. Summarize into the body sections: preserve facts, the decision, the rationale,
   and the reusable pattern; drop transcript noise.
5. Write the new file under the destination path.

## Final response

After writing, report:

- Raw file created (full absolute path)
- Example type and project
- Header fields left blank / open questions preserved

Then **always prompt the user to manually triage and ingest it from the memory
repo** (not from this repo):

> Approved example captured to the Agentic OS memory. To review and promote it,
> from `~/agents/agentic-os` run:
> `/promote-draft-memory <path>` then, once approved, `/ingest <path>`.

Do not run either yourself — wait for the user.
