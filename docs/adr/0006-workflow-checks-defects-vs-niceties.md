# WorkflowRegistry separates objective defects from editorial niceties

The WorkflowRegistry status (`Missing links` / `Needs review` / `Stale` / `OK`) is driven
**only by objective defects**. Editorial checks (has examples, has "when to use", related
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

## Principle

WorkflowRegistry is a discovery and quality signal, not a ceremony enforcer. Flag objective
defects; surface editorial metadata separately, so real problems don't drown in false
warnings.
