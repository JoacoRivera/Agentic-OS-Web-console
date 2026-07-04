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

## Scalar metrics (the same principle applies to the gauges, not just the chart)

File/path counts are not knowledge counts. `raw/` is **append-only** — promotion *copies*
into `wiki/` and **keeps** the raw original — so raw and wiki are two independent monotonic
stores with different authority (`raw/` = immutable evidence/archive; `wiki/` = synthesized,
published memory), **not** a left-to-right pipeline. The scalar stats must reflect this:

- **`wikiN`** — published memory page count. **This is the headline** ("Published memory" /
  "Wiki pages"), the canonical synthesized tier.
- **`rawN`** — raw source-archive count ("Raw capture archive" / "Source files"). Append-only
  evidence, **not** a backlog; it only ever grows and never drains via promotion.
- **`all`** — total files across tiers. If shown, label it "Total files across tiers" and make
  clear it **double-counts a promoted item** (it remains as both raw source *and* wiki
  synthesis). Never present `all` as "total memory/knowledge".
- **`draftN`** — unapproved captured examples (the review queue, drained by a `status` edit
  *inside the raw file*), **not** "unprocessed raw backlog". Promotion ≠ approval.
- **No deduped "knowledge total"** (e.g. by basename) until lineage metadata exists — that is
  the exact fakery this ADR forbids.
- **No funnel/burndown visual** between `raw/` and `wiki/`; raw never decreases.
