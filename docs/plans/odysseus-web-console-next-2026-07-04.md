# Odysseus Web Console — post-P3 roadmap (2026-07-04)

Status: proposed (nothing here is committed work)
Baseline: Phases 1–3 of `odysseus-web-console-2026-06-29.md` are **complete** —
read-only console, guided operations, and controlled execution (allowlist +
dry-run + confirm + diff + audit) all shipped and verified (90/90 tests,
29/29 verify checks, five `check:*` scripts green against the live repo).

This plan proposes what to build next. It introduces no new invariants; every
item either operates within the existing ADRs or explicitly names the ADR
amendment it would require. Phase numbers continue from the original plan.

## Where the product actually stands

- The console is feature-complete against its original charter and runs
  loopback-only with no auth layer (`AUTH_CONFIGURED` is hardcoded `false`).
- There is **no CI**: tests, verify, and the checks run manually.
- Execution is synchronous: `POST /run` holds the HTTP request open for the
  whole run (`verify` takes ~30s+ with its nested build), with no streaming
  and no run history on the operation cards.
- The audit log grows without bound and the Audit view does not auto-refresh
  after a run.
- Live registry signal (2026-07-04, morning): **all 10 workflows reported
  `needs-review`** — the registry working as designed (objective defects
  only, ADR-0006). *Update, same day:* the memory repo cleared most of it —
  9/10 now OK, with `manual-operations.md` still `needs-review` (no stated
  verification). Clearing the rest stays content work in
  `~/projects/agentic-os`; the console's job (P4.4) is to make the "why" and
  the fix path more actionable.

## Phase 4 — Operate & harden (no new ADRs)

**Status: shipped 2026-07-04** (all four items, in the recommended order —
CI, audit retention/history, async streamed runs, actionable needs-review).
Sections kept for the record:

### 4.1 CI for the console repo
GitHub Actions on push/PR: `npm ci`, `npm test`, `npm run check:paths`,
`npm run build`. These are repo-independent (tests use fixtures; check:paths
is a pure table test). The live-repo checks (`check:docs`, `check:workflows`,
`check:skills`, `check:metrics-groundtruth`, full `verify`) need the memory
repo and stay local/manual — or run in CI against a small committed fixture
repo under `platform/server/test/fixtures/` (the tests already own such
fixtures; reuse, don't duplicate). Verification: a red PR on a deliberately
broken test; a green run on main.

### 4.2 Asynchronous runs with streamed output
Replace the request-held run with a job model, keeping the safety flow
byte-for-byte: dry-run → confirm token → `POST /run` returns `202` with a
`runId`; `GET /api/operations/runs/:runId` polls status; output streams via
SSE (same-origin, still behind the Host/Origin guard — no new surface).
Single-flight stays (one live run globally). The audit line is written at
completion exactly as today, same shape. This resolves the open question from
the P3 capture ("should slow `verify` stay UI-equal?") by making slowness a
UI-visible state instead of a frozen button. Verification: run `verify` from
the browser, watch output stream, confirm one audit line at completion;
concurrent second run still 409.

### 4.3 Audit log retention + usable history
- Rotation: size-based rollover of `platform/logs/operations.log` (e.g. keep
  N rotated files; pick numbers at implementation time). The reader already
  tolerates non-JSON lines; rotation must never rewrite existing lines —
  append-only stays append-only.
- UI: filter by operation and status; auto-refresh the Audit view after a run
  completes; show "last run: <ts> · <status>" on each executable card,
  derived from the audit tail (no new state store).
Verification: rotate at a tiny threshold in a test, assert no line loss
across the boundary; card shows the entry just produced.

### 4.4 Make `needs-review` actionable
The registry says *what* is defective; shorten the path to *fixing* it:
per-workflow defect detail already exists (`/api/workflow?path=`), so the
console side is small — a "fix hints" line per failed check (e.g. "add
`workflow_kind:` frontmatter", "link from index.md") and a copyable
`/aos-implement` prompt for the fix as a Guided-Operation-style preview.
**The console still never edits the memory repo** (ADR-0001 spirit: judgment
fixes belong to the LLM/user in the memory repo). The actual clearing of the
10 `needs-review` rows is memory-repo editorial work, tracked there.

## Phase 5 — Auth design (ADR-0008 candidate; prerequisite for anything non-loopback)

ADR-0005 made "non-loopback without auth" a startup failure and deliberately
left auth undesigned. Design it before anyone is tempted to tunnel around it:

- Minimal viable shape: a static bearer token in `platform/.env`
  (`AUTH_TOKEN`), constant-time comparison, required on every `/api/*`
  request when set; `AUTH_CONFIGURED` becomes derived (`Boolean(AUTH_TOKEN)`)
  instead of hardcoded `false`. Dashboard sends it from a login prompt
  (sessionStorage, never localStorage, never a query param).
- Loopback binding stays the **default** and the Host/Origin defense stays
  mandatory even with auth (defense in depth — token theft via rebinding is
  exactly the scenario ADR-0005 exists for).
- Non-goals: multi-user, roles, OAuth, TLS termination (document "TLS via
  reverse proxy or don't leave localhost").
- Deliverable is the **ADR + implementation gated on it** — the ADR decides
  whether we even want non-loopback operation, or whether auth exists purely
  as belt-and-braces on loopback.
Verification additions to `verify.mjs`: with `AUTH_TOKEN` set, unauthenticated
requests are 401 and a non-loopback HOST now *boots* (in a test env) — and
without it, today's refusal behavior is unchanged.

## Phase 6 — `check:wiki-structure` (requires an ADR-0001 amendment)

ADR-0001 already anticipates this split: `/aos-wiki-lint` (LLM judgment,
guided forever) vs a deterministic `check:wiki-structure` (executable). The
memory repo's `scripts/wiki-lint.py` *is* that deterministic half and already
has its own regression suite. Proposal:

- New allowlist entry `check:wiki-structure` → fixed command
  `python3 scripts/wiki-lint.py` run in `REPO_ROOT` (command table row, same
  executor, nothing else changes).
- **Gate:** the permanent allowlist is closed by ADR-0001/CLAUDE.md ("contains
  only" the six checks). Extending it requires a recorded ADR-0001 amendment,
  like the `check:hud-parity` retirement — do not slip it in as a code change.
- The guided `/aos-wiki-lint` card stays: the judgment pass (contradictions,
  drift, invented certainty) is not and never will be executable.
Verification: catalog invariant tests updated with the amendment; dry-run
shows the fixed python command; run appends an audit line; `wiki-lint.py`'s
own suite (`/aos-test-wiki-lint`) still owns the linter's correctness.

## Phase 7 — Platform Apps, separate-origin (ADR-0004 return; furthest out)

Only if app hosting is actually wanted. The deferral reason stands: same-origin
hosting would give any bundle (and its npm supply chain) ambient `/api/*` read
access. The return design per ADR-0004:

- A **second listener** on a distinct port serves `platform/apps/*/dist`
  statically (still loopback, still no backend spawning — the "local app
  supervisor" remains a separate, undesigned product).
- The API **denies app origins by default**; a per-app grant (explicit CORS
  origin + scoped token, once Phase 5's auth exists) is the only way an app
  reaches `/api/*`. Phase 5 is therefore a hard prerequisite.
- Sidebar entry returns only when this ships; until then the section stays out.
Verification: an app served on the second origin gets 403 from `/api/*` with
no grant; with a grant, only the granted origin passes; `verify` gains both
assertions.

## Cross-repo note (not console work)

Resolved 2026-07-27: ADR-0003 now defines explicit `source_id`,
`knowledge_intake_date`, and `promoted_from` frontmatter lineage. The console
charts distinct knowledge intake, excludes unlineaged/invalid files without a
Git fallback, and exposes lineage coverage plus capped structural
`{path, reason}` problems without raw content. The chart states whether lineage
is complete or incomplete. Backfilling the memory repo remains a separate
cross-repo migration.

## Standing non-goals (unchanged, load-bearing)

- The console never executes LLM Skills — no headless Claude, ever (ADR-0001).
- No generic terminal/shell endpoint, regardless of auth (ADR-0001).
- No backend process supervision under "Platform Apps" (ADR-0004).
- No public/LAN exposure ahead of the Phase 5 ADR (ADR-0005).

## Recommended order

**4.1 → 4.3 → 4.2 → 4.4**, then the Phase 5 ADR discussion. Phase 6 whenever
the ADR-0001 amendment is worth the ceremony (cheap, high value). Phase 7 only
on real demand, after Phase 5. Each phase lands with its own verify.mjs
additions and tests, same as P1–P3; DoD for the roadmap doc itself is that
each shipped item retires its section here or spawns its ADR.
