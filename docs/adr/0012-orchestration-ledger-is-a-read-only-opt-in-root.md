# The Orchestration Ledger section is a read-only, opt-in, loopback-gated third root

Status: proposed — 2026-11-14 (DRAFT; not accepted, nothing here is implemented)

**Deferred by owner decision — 2026-11-14.** This draft stays `proposed` and nothing is
implemented. Reason: the ledger home holds a one-day development/test corpus that the
memory repo ruled ineligible for routing-quality claims, and the ledger has no supported
read API. Revisit when the ledger holds real orchestration Episodes, or when the memory
repo offers a supported read interface.

## Context

The Agentic OS memory repo carries an orchestration layer: `aos implement`
(`scripts/orchestrator.py`) drives a task through an implementer turn and an independent
review, routes each turn through `router_policy`, and has every provider turn authorized
by an **execution ledger** before it runs and recorded as observed afterwards
(`scripts/ledger_store.py`, `ledger_records.py`, `ledger_session.py`,
`ledger_observation.py`; contract in `wiki/agentic-os-execution-ledger.md`). The ledger
lives **outside every repository**, under `$AOS_LEDGER_HOME` (default
`~/.agentic-os/ledger`), as `<repo_id>/episodes/<episode_id>/{episode.jsonl,
journal/cp-NNN-<digest>.json, executions/<execution_id>.jsonl, seals/seal-NNN.json}` plus
a per-repository `seals.chain.jsonl`. The console shows none of it.

A section that shows it would be a third filesystem root, after `REPO_ROOT` and the
Family Health record (ADR-0010). Five facts about the source, verified against the memory
repo at `1905a94` on 2026-11-14, shape what such a section may be:

- **The ledger is frozen history.** The memory repo's own ADR-0001 (2026-09-19) refocused
  the roadmap; the ledger page states "history, not an active plan" and the read side
  (phase 6A-ii) was closed as not planned.
- **There is no supported read interface.** `ledger_store.py` declares itself an
  "internal module" with "no supported public API of any kind, read or write". The
  writer process's JSON protocol has a per-episode `verify` operation and no listing
  operation. The memory repo records that "no canonical session-view semantics exist"
  and that "no query layer was built or authorized".
- **The existing corpus carries a binding caveat.** A test-isolation defect let test
  runs write into the operator's real ledger home. The memory repo decided the
  pre-fix corpus "is not eligible for routing-quality or statistical claims" and that
  individual entries will not be retrospectively classified.
- **The ledger is privacy-safe by construction; its neighbours are not.** Ledger records
  hold digests, enumerations, counts and timestamps (a task label is stored as a digest
  and a byte count; a session id as a digest; paths are relative to the ledger). The
  sibling homes `$AOS_CLI_HOME` (task records, `ask.jsonl`) and `$AOS_EVIDENCE_HOME`
  (retained documents) hold the operator's request text in cleartext.
- **Three facts are kept apart on purpose.** AUTHORIZED (the tier the validated decision
  selected), REQUESTED (the invocation plan the tier binding produced) and OBSERVED (what
  provider evidence proves ran) are never collapsed, and "authorization consumed" is not
  "provider succeeded".

Existing invariants that apply unchanged: ADR-0001/0009 (the console never executes an
LLM Skill, and the Phase-3 allowlist holds deterministic checks only), ADR-0005 (loopback
bind, Host/Origin defense, sensitive roots hidden through the proxy by default; path
safety does not make a root safe to expose), ADR-0010 (the pattern for a second root).

## Decision

1. **A third, optional root, named by the console's own variable.** `LEDGER_ROOT` names
   the ledger home. It has **no default** and is **not** read from `AOS_LEDGER_HOME`: an
   ambient variable exported for the memory-repo tooling must never switch a console
   section on. Unset means the section does not exist (`404
   orchestration-ledger-not-configured` on every route; the dashboard shows "not
   configured"). The root must not lie inside `REPO_ROOT` or `HEALTH_REPO_ROOT`, nor
   contain either; violating that refuses startup.
2. **The ledger home only.** `$AOS_CLI_HOME` and `$AOS_EVIDENCE_HOME` are out of scope:
   they hold operator prose. The section never reads them, and a `LEDGER_ROOT` that
   resolves to, inside, or above either default sibling (`~/.agentic-os/cli`,
   `~/.agentic-os/evidence`, i.e. `~/.agentic-os` itself) refuses startup. Showing task
   text or retained documents would need its own decision.
3. **No client paths.** The API accepts identifiers only: a `repo_id`
   (`sha256:` + 64 hex) and an `episode_id` (UUID), each validated by a strict pattern
   and then matched against a directory listing — never joined into a path from client
   input. There is no generic file route. `/api/docs/*` cannot reach the ledger root and
   `/api/orchestration-ledger/*` cannot reach either repo root. Symlinks are not
   followed.
4. **Loopback-only by default, even behind the proxy.** Every
   `/api/orchestration-ledger/*` request through `PROXY_HOSTNAME` is refused (`403
   orchestration-ledger-proxy-refused`) unless `ORCHESTRATION_LEDGER_ALLOW_PROXY=true`.
   That flag without both `LEDGER_ROOT` and a configured proxy is invalid configuration
   and refuses startup. Turning it on for a deployment is an owner decision recorded as
   an amendment here.
5. **Read-only, and nothing is executed.** The section opens ledger files for reading
   and does nothing else: no write, no lock file taken or created, no repair, no
   quarantine, no staging purge. It does not spawn `ledger_session.py` or any other
   process, and it adds nothing to the Phase-3 executable allowlist. A deterministic
   `check:orchestration-ledger` script may exist for the owner to run by hand; it prints
   counts only and is **not** allowlisted.
6. **A fixed field allowlist, never a raw record.** Responses are projections built from
   a named list of fields (identifiers and digests, event types, timestamps, stage,
   active role, decision status, review state, selected/effective route, authorized tier,
   requested invocation plan, observed provider/models/efforts, classification verdict,
   outcome status, token counts). A field not on the list is not returned, so a later
   ledger generation cannot leak a new field through the console by default.
7. **A structural read, with no integrity claim.** The console does not re-implement the
   ledger's chain, seal or digest verification and never labels an episode "verified".
   Each row reports what was read and, where a file is missing, torn, or of an unknown
   schema generation, a typed `{id, reason}` problem — excluded and counted, never
   guessed (the ADR-0003 lineage rule applied to a new source). Verification stays with
   the memory repo's own `verify` operation; if it is ever surfaced as an Operation it
   is **Guided** (command preview only).
8. **Render and count; never interpret.** AUTHORIZED, REQUESTED and OBSERVED are shown as
   three separate columns and are never merged or compared into a verdict of the
   console's own; the classifier verdict shown is the one the ledger recorded. An
   observation with no observed model is shown as absent, never filled from the request.
   The section computes counts by recorded state and nothing else: no success rate, no
   routing-quality score, no cost or token totals across episodes, no model comparison.
   Every pane carries the fixed line "Structural record of what the ledger holds — not
   evidence of routing quality." A figure that cannot be computed is reported absent
   with its reason, never as zero.
9. **No leakage into shared surfaces.** Ledger data never enters `/api/metrics`,
   `/api/docs/*`, `/api/memory/query`, the Operations catalog, the audit log, server
   logs, or error messages. Error bodies carry codes only. `/api/status` reports
   `orchestrationLedgerConfigured` and `orchestrationLedgerAllowProxy` and nothing else.
10. **The reader mirrors the memory repo's layout and says which generation it knows.**
    `server/src/orchestrationLedger.js` follows the directory layout and file-name
    patterns of `scripts/ledger_store.py` and the record fields of
    `scripts/ledger_records.py` / `ledger_observation_records.py`. It pins the
    `ledger_schema_version` values it understands and reports any other as unreadable.
    When those scripts change, the reader changes with them (the invariant-8 rule for
    capture state, applied here).
11. **Its own vocabulary.** The section is **Orchestration Ledger**; its nouns are
    **Episode**, **Checkpoint**, **Authorization** and **Observation**, defined in
    `docs/CONTEXT.md` from the memory repo's contract. "Run", "task" and "job" are
    avoided: a ledger Episode is not an Operation run and never appears in the audit log.

## Consequences

- New config: `LEDGER_ROOT` (default unset) and `ORCHESTRATION_LEDGER_ALLOW_PROXY`
  (default `false`). The VPS deployment leaves both unset unless a later amendment says
  otherwise.
- Verification must assert: unset root → 404; malformed or unknown id → 400/404 with a
  code-only body; no route accepts a path; the docs API cannot read the ledger root;
  proxied request → 403 by default and 200 only with the flag; the flag without a root
  or a proxy refuses startup; a root inside or above a repo root or the sibling homes
  refuses startup; the root is byte-identical before and after a full read (no write, no
  lock file); an unknown schema generation yields a problem row, not a guess.
- Fixtures are synthetic, generated for the tests, with invented digests and ids. No
  record, id, digest or path from a real ledger home enters this repository, its tests,
  screenshots or commit messages.
- The console becomes the first reader of a format its owner repo calls internal and
  unsupported. That is a standing maintenance cost with no upstream compatibility
  promise; decision 10 makes drift visible rather than silent, and does not remove it.
- CLAUDE.md gains a ninth hard invariant summarizing this ADR when it is accepted.

## Open questions for the owner

1. **Build now, defer, or drop.** On the reviewing host the ledger home holds only what
   was written during the ledger's own development, which is the corpus the memory repo
   ruled ineligible for statistical claims, and nothing has been written since the
   platform was frozen. The section would therefore display a fixed historical corpus.
   The draft's recommendation is to keep this ADR `proposed` and not implement it until
   the memory repo produces post-baseline episodes.
2. **Proxy exposure.** Whether the ledger home exists on the VPS at all, and if so
   whether `ORCHESTRATION_LEDGER_ALLOW_PROXY` should be set there.
3. **Integrity display.** Whether a structural read with no verification (decision 7)
   is acceptable, or whether a view is only worth having once the memory repo offers a
   supported read/verify interface.
