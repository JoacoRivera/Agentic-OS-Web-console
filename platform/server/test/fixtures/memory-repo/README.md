# Fixture: memory repo

Synthetic, invented data for the console's CI checks (`npm run ci:fixture`). Nothing here
is real memory: every capture, page, log entry, path and ID was made up for the tests, and
every `source_id` uses the reserved pattern `00000000-0000-4000-8000-0000000000NN`.
The `.claude/skills/*/SKILL.md` files are inert stubs, not Skills.
The stub `.claude/skills/aos-*` shadow the real Skills inside this directory and must never
be invoked.

Mirrors the Agentic OS memory-repo layout: `AGENTS.md`, `wiki/` (with `log.md` and the
`log/YYYY-MM.md` archive), `raw/` captures, `templates/`, `.claude/skills/`, and
`scripts/capture-holds.txt`. One file per case; the file name is the case name.

## Adding a case

1. Add the file (synthetic content only, no text copied from the real memory repo).
2. Add one row for it to the case table in `server/test/fixture-repo.test.js`, and adjust
   the hand-derived totals there. Existing rows are not edited.
3. Run `npm test` and `npm run ci:fixture` from `platform/`.

The guard test fails when a file has no row, a row has no file, or the fixture stops
covering a capture state, lineage verdict, `workflow_kind` or workflow status.
