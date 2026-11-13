# Knowledge growth uses explicit intake lineage

Status: accepted; amended 2026-07-27 and 2026-11-13

The console's growth chart is keyed on explicit semantic lineage. It counts distinct
knowledge-intake sources by `knowledge_intake_date`, deduplicated by `source_id`.
A published page that declares `promoted_from` resolves to its raw origin(s) and does
not create another intake event.

Three distinct dates exist: `knowledgeIntakeDate` (first entry, ~raw capture),
`wikiPublishDate` (wiki doc created/promoted — publishing, not intake), and `pathAddedDate`
(Git path add). Only `knowledgeIntakeDate` drives the knowledge-growth series.

## Lineage frontmatter

An intake origin under `raw/` or `wiki/` declares both fields:

```yaml
---
source_id: 550e8400-e29b-41d4-a716-446655440000
knowledge_intake_date: 2026-07-27
---
```

- `source_id` is a generated UUID in canonical 8-4-4-4-12 textual form and is the
  stable, repository-wide identifier for one intake event. Moving, renaming, or
  publishing a file does not mint a new ID. UUID comparison is case-insensitive;
  the metrics implementation normalizes accepted IDs to lowercase before identity,
  deduplication, and conflict checks.
- `knowledge_intake_date` is written with the exact bare source representation
  `YYYY-MM-DD` for when that source first entered Agentic OS. Quoted values,
  timestamps, inline comments, invalid calendar dates, and future dates are invalid;
  the value is not inferred from Git or filesystem timestamps.

A synthesized/published page derived from one or more raw sources declares
`promoted_from` instead:

```yaml
---
promoted_from:
  - raw/projects/example/capture-2026-07-27.md
wiki_publish_date: 2026-07-28
---
```

- `promoted_from` is a raw repo-relative Markdown path or list of paths. The console
  recursively inherits each referenced origin's source ID and intake date.
- A derived page must not also declare `source_id` or `knowledge_intake_date`; that
  would ambiguously claim both "new intake" and "derived publication".
- `wiki_publish_date` is optional publishing metadata and is not used by the intake
  series.
- Multiple files may resolve to the same `source_id` and date; they count once.
  A source ID declared with conflicting dates is invalid and excluded.

Files with absent, partial, unsafe, unresolved, or conflicting lineage are excluded
from knowledge metrics. `/api/metrics.lineage` reports eligible, lineaged,
unlineaged, invalid, promoted, conflicting-source, and future-dated-source counts
so an incomplete backfill remains visible. Its `problems` field exposes at most 20
objects containing only `{path, reason}`, sorted by reason and then path. Its companion
`reasonCounts` is an uncapped aggregate: a key-sorted map from each present reason code to
a positive integer count over the complete problem set, `{}` when there are no problems.
It contains neither paths nor body content, and its values sum to `unlineagedN + invalidN`.
Stable reason
codes are `invalid-frontmatter`, `missing-lineage`, `partial-origin`,
`origin-and-promotion`, `invalid-source-id`, `invalid-intake-date`,
`future-intake-date`, `conflicting-source-id`, `unsafe-promoted-from`,
`missing-promoted-from`, `invalid-promoted-from-lineage`, `promotion-cycle`, and
`unreadable-file`. There is deliberately no raw body content and no Git/mtime fallback:
guessed history would turn an incomplete migration into false knowledge.

## Consequences

- The chart is labeled "Knowledge intake" and its cumulative `series` ends at
  `knowledgeN`, the distinct valid source count. It explicitly reports `Lineage
  incomplete` when `unlineagedN + invalidN > 0` and `Lineage complete` when the sum
  is zero.
- Promotion raw → wiki counts as wiki publishing, never as new knowledge intake.
- Do not rely on Git rename behavior as the semantic source of truth for creation.
- `pathAddedDate` is no longer a metrics input. Repository file counts remain
  available separately for operational inventory.
- Existing memory needs an explicit frontmatter backfill before it appears in the
  intake series; the console does not edit or migrate the memory repo.

## Prior decision

Before the 2026-07-27 amendment, lineage metadata did not exist. The chart therefore
used `pathAddedDate` and was correctly labeled "Repository file growth". That fallback
is retired now that the lineage contract exists; it must not be reintroduced for
unlineaged files.

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
- **`draftN`** — Draft captures not yet ingested (the ingest queue, drained when `/aos-ingest`
  flips `Status: Draft` to `Status: Ingested` *inside the raw file*), **not** "unprocessed raw
  backlog". See the capture-lifecycle amendment below; the original "unapproved / review
  queue" wording is superseded.
- **`knowledgeN`** — distinct valid lineage sources, deduplicated by `source_id`.
  This is the knowledge-intake total and excludes unlineaged/invalid files.
- **No funnel/burndown visual** between `raw/` and `wiki/`; raw never decreases.

## Capture-lifecycle amendment (2026-11-13)

The memory repo's own ADR-0002 (2026-11-07, "the memory flow runs without human
checkpoints") retired triage, the risk classes and the delegated approval flip. A capture
has two states, **Draft** and **Ingested**; `Status: Approved` is the legacy spelling of
Ingested (the ~256 captures from before the change keep it). A Draft named in the memory
repo's `scripts/capture-holds.txt` is **on hold**. The console's earlier rule — a capture
counts as done only when its first `status:` line reads `Approved` — therefore misread every
new `Status: Ingested` capture as pending (21 phantom drafts on 2026-11-13 against 0 in the
memory repo's own inventory).

The console now classifies captures exactly as the memory repo's capture inventory
(`scripts/aos_wiki/inventory.py`) does, so the two cannot disagree about the same tree:

- **Scope:** every `raw/**/*.md` with an `examples` path segment, plus any other raw file
  carrying an unqualified `Status:` line; templates (`_template.md`, `*-template.md`, a
  `template(s)/` directory) are out of scope.
- **State:** exactly one canonical `Status: Draft | Ingested | Approved` line, else `none`
  (the Draft side). A capture is Ingested when its marker says so **or** when there is
  ingestion evidence — a wiki page's frontmatter `source:` naming it, or an `ingest` log
  entry (in `wiki/log.md` or the `wiki/log/YYYY-MM.md` archive) naming it. Disagreements are
  counted as Ingested and surfaced as `captures.mismatchN`, never silently absorbed.
- **Fields:** `capN = draftN + heldN + ingestedN`; `drafts[]` / `held[]` (capped at
  `DRAFT_LIMIT`); `captures.{legacyApprovedN, mismatchN, layoutWarningN, holdWarningN}`
  (counts only). `apprN` is removed.

The memory-health cadence follows the same repo's maintenance-pass rule
(`scripts/wiki_log.py`): only a `lint | maintenance pass` entry resets the timer, read across
the log and its archive; due at 7+ days, overdue at 10+ (`health.{lastPass, passAge,
healthStale, overdue, ingestedSincePass}`; `lastLint`/`lintAge` are removed). The archive
files are the log, not pages: they no longer count in `wikiN` or lineage coverage, as the
memory repo's lint exempts them from every page check. `check:metrics-groundtruth` recounts
all of this independently.
