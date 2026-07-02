# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This is a **single-context** repo. Note the domain docs live under `docs/`, not the repo root.

## Before exploring, read these

- **`docs/CONTEXT.md`** — the ubiquitous language (domain glossary + principles). Read this first; its terms (Skill, Workflow, Operation, and the three distinct dates) are load-bearing and must be used precisely.
- **`docs/adr/`** — the accepted architecture decisions (`0001..0006`). These are binding invariants. Read the ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## The external Agentic OS memory repo

This console operates on a **separate** repository — the Agentic OS Markdown memory wiki at `~/agents/agentic-os` (`raw/` captures → polished `wiki/`, operated by an LLM harness). When a task touches what the console reads (memory tiers, the five Skills under `.claude/skills/`, workflows under `wiki/workflows/`, the deprecated `dashboards/aos-hud.js`), consult that repo's `~/agents/agentic-os/AGENTS.md` for its conventions and ubiquitous language. Treat it as a secondary domain source — it is the system this console describes, not part of this repo's tree.

## File structure

```
/
├── docs/
│   ├── CONTEXT.md
│   └── adr/
│       ├── 0001-console-never-executes-llm-skills.md
│       └── ...0006
└── platform/            ← per the plan; not yet scaffolded
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `docs/CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids — in particular, keep **Skill**, **Workflow**, and **Operation** distinct, and never collapse the three dates (`knowledgeIntakeDate`, `wikiPublishDate`, `pathAddedDate`).

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0001 (the console never executes LLM Skills) — but worth reopening because…_
