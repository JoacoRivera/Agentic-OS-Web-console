# Growth chart measures file growth (pathAddedDate), not knowledge intake

The console's growth chart is keyed on `pathAddedDate` — when Git first saw the current
file path (`git log --diff-filter=A`). This is **not** the date knowledge entered the
system. We therefore label the chart "Repository file growth" / "Wiki/raw file growth" and
explicitly do not claim it measures "knowledge accumulation".

We decided this because the repo's core behavior — promoting `raw/` captures into `wiki/`
via `/ingest` and `/promote-draft-memory` — makes a single "creation date" ambiguous.
A promotion adds a new wiki path on the promotion date even though the knowledge was
captured earlier; and Git may record a move as rename *or* delete+add depending on
similarity detection, so Git history is not a reliable semantic source for memory creation.

Three distinct dates exist: `knowledgeIntakeDate` (first entry, ~raw capture),
`wikiPublishDate` (wiki doc created/promoted — publishing, not intake), and `pathAddedDate`
(Git path add). Only the last is computable today.

## Consequences

- Phase 1: rename the chart to "Repository file growth"; use `pathAddedDate` only.
- Promotion raw → wiki counts as wiki publishing, never as new knowledge intake.
- Do not rely on Git rename behavior as the semantic source of truth for creation.
- TODO (future ADR): true knowledge-intake growth requires stable lineage metadata —
  frontmatter `created`, `source_id`, `promoted_from`, or an ingest log. Until that exists,
  no "knowledge accumulation" claim is made.
