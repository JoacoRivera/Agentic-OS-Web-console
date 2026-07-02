# WorkflowRegistry separates objective defects from editorial niceties

The WorkflowRegistry status (`Missing links` / `Needs review` / `Unclassified` / `Stale` /
`OK`, in that precedence — see ADR-0007 for `Unclassified`) is driven **only by objective
defects**. Editorial checks (has examples, has "when to use", related
skill exists) are **informational-only** and never turn a row yellow. Required checks are
selected per workflow by a frontmatter `workflow_kind`
(`runbook | reference | style-guide | policy | inventory | eval-suite`), with `checks_exempt`
to opt out of a check that legitimately doesn't apply.

We decided this because the original checks were uniform string-match heuristics applied to
every file: a style-guide like `german-technical-emails` would be flagged `Needs review`
forever for lacking a runbook's "when to use" / examples / verification ceremony it never
needed. A registry that's wrong as often as it's right trains the user to ignore it, hiding
genuinely broken workflows in a sea of false yellow.

## Consequences

- **Registry inclusion**: real workflow docs only. Exclude data/example/result folders by
  default — `wiki/workflows/**/{examples,cases,results}/**` (incl. `evals/cases/*`,
  `evals/results/*`, task-mode examples, german-email examples). These appear as related
  data under their parent workflow, not as workflows with status verdicts. (Matches the
  `non-example` rule the metrics already use.)
- **Status-impacting**: missing from `index.md` (`Missing links`); broken/unsafe metadata
  (`Needs review`); TODO/FIXME/open questions (`Needs review`) unless marked
  accepted/standing; missing verification **only** for kinds where it's expected; `Stale`
  only after objective checks pass.
- **Informational-only**: has examples; has "when to use"; related skill exists; referenced
  from `agentic-os-usage.md` (unless the kind requires it).
- **Verification**: "verification: not applicable" is an explicit decision, shown as-is,
  never flagged missing. (Honors the centralized verification convention.)

## `workflow_kind` is a label + a small status policy — not a ceremony matrix

`workflow_kind` is a closed classification vocabulary. Its status behavior is intentionally
small: it maps each kind to **two derived booleans** — `requires_verification` and
`requires_runbook_shape`. Those two are the *only* kind-dependent status inputs; everything
else (index link, broken metadata, unaccepted TODO) is kind-independent.

| kind          | `requires_verification` | `requires_runbook_shape` |
| ------------- | ----------------------- | ------------------------ |
| `runbook`     | yes                     | yes                      |
| `eval-suite`  | yes                     | no                       |
| `policy`      | no                      | no                       |
| `reference`   | no                      | no                       |
| `inventory`   | no                      | no                       |
| `style-guide` | no                      | no                       |

**In P1 only `runbook` and `eval-suite` are status-distinct.** `policy`, `reference`,
`inventory`, and `style-guide` are status-equivalent, and that is fine and deliberate: they
still drive labels, grouping, sort/filter, detail-page hints, and informational checks — just
not yellow status. **Do not invent per-kind requirements to make the taxonomy feel balanced.**
A new per-kind required check is added only when it catches a real objective defect.

- **`requires_verification` is about a stated validation method, not a magic heading.** The
  defect is "no stated way this workflow is validated/run", satisfied by any of `## Verification`,
  a "Manual run checklist", "Result recording", or equivalent — and an explicit
  "Verification: not applicable" is itself a satisfying decision, never flagged. This matters
  for `eval-suite` (`evals.md`): an eval suite isn't a task result, but it must state how it
  is run or manually judged.
- **`inventory` has no extra P1 required check.** Its real failure mode is drift; for P1 that
  is covered by the kind-independent checks plus `Stale`. An inventory-specific drift check
  (e.g. `harness-inventory.md`'s listed components vs. actual paths) is added later *only* if
  there is a deterministic source to compare against and it is implemented honestly.

## Unclassified

A workflow with no `workflow_kind` is **Unclassified** — neither `OK` nor a defect color —
because its kind-dependent booleans can't be derived. There is no default kind and the kind
is never inferred. See ADR-0007 for the full rule and the P1 backfill (status precedence
becomes `Missing links > Needs review > Unclassified > Stale > OK`).

## Principle

WorkflowRegistry is a discovery and quality signal, not a ceremony enforcer. Flag objective
defects; surface editorial metadata separately, so real problems don't drown in false
warnings.
