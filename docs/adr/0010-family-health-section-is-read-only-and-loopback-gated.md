# The Family Health section is read-only, opt-in, and loopback-gated

Status: accepted — 2026-09-17

## Context

The owner keeps a plain-Markdown family medical record in a **separate private
repository** (`Health-Management`: `family-overview.md`, one `members/<name>/` folder with
`profile.md`, `history.md`, dated `exams/*.md` notes and original `documents/`, plus shared
`reference/`). The Agentic OS memory repo holds the **synthesized** side of that project
(`wiki/projects/family-health-tracker.md` and one wiki page per member) and an immutable
dated raw snapshot from 2026-07-23. The memory pages fix the privacy posture: private
visibility is the accepted boundary, not end-to-end secrecy; medical detail stays inside
the tracker and its raw sources; any finding is *data to raise with a physician, never a
diagnosis*; lab reference ranges are per-lab and never reusable thresholds.

The console wants a section that shows this record live: a family dashboard, a pending
list, and a per-member medical file. That is a new class of data for the console. Unlike
`raw/`, where the *metrics* are harmless and only the *content* is gated, a family-health
dashboard is itself identifiable clinical data. Two existing invariants shape the answer:

- ADR-0005: loopback bind is necessary but insufficient; sensitive content defaults to
  hidden even through the authenticated tailnet proxy, and path safety never makes a root
  safe to expose.
- ADR-0001: the console never executes an LLM procedure. The medical-document intake is a
  judgment procedure (`wiki/projects/family-health-tracker/medical-document-intake.md`),
  so the console can only ever describe it.

## Decision

1. **A second, optional repo root.** `HEALTH_REPO_ROOT` names the live tracker clone. It
   has **no default**: unset means the section does not exist (`404
   family-health-not-configured` on every route, and the dashboard shows "not
   configured"). The clone's location is per-machine, so it is never guessed. The root
   must not lie inside `REPO_ROOT` (nor contain it): the 2026-07-23 raw snapshot is
   evidence, not a data source, and pointing the section at it is invalid configuration.
2. **Its own allowed roots and its own path safety.** Client paths for the section resolve
   with `paths.safeResolve` against `HEALTH_REPO_ROOT` and the roots
   `family-overview.md`, `members/`, `reference/` only. The health root is never added to
   the memory-repo `ALLOWED_ROOTS`; `/api/docs/*` cannot reach the tracker and
   `/api/family-health/*` cannot reach the memory repo.
3. **Loopback-only by default, even behind the proxy.** Every `/api/family-health/*`
   request that arrives through `PROXY_HOSTNAME` is refused (`403
   family-health-proxy-refused`) unless `FAMILY_HEALTH_ALLOW_PROXY=true`. That flag is
   invalid configuration without both `HEALTH_REPO_ROOT` and a configured proxy, and the
   server refuses to start. Turning it on for the tailnet deployment is a deliberate
   owner decision recorded as an amendment here, not a deploy-time default.
4. **Read-only, Markdown only, no binaries.** The section writes nothing to the tracker.
   It reads Markdown; original documents (PDF/JPEG scans) are listed by name, size and
   absolute path only and are never served over HTTP in this version. Intake stays a
   human/LLM procedure; if it is ever surfaced as an Operation it must be **Guided**.
5. **No leakage into shared surfaces.** Family-health data never enters `/api/metrics`,
   `/api/docs/tree|file|search|backlinks`, `/api/memory/query`, the Operations catalog,
   the audit log, server logs, or error messages. Error bodies carry codes only. The
   deterministic `check:family-health` script prints counts only and is **not** in the
   Phase-3 executable allowlist, because run output lands in the audit log and would be
   startable through the proxy.
6. **Render, count, and chart; never interpret.** The console shows clinical rows
   verbatim from the notes and computes only counts, dates, and numeric series. A lab
   trend point always carries the unit and reference range printed on *its own* exam note;
   the chart draws no universal threshold. Pending items come from explicit signals in the
   notes (unchecked `- [ ]` items, bold `Pendiente`/`Pending` markers, lab rows whose
   result is `Pending`, exam notes whose original document is recorded as missing), never
   from inference. Every clinical pane carries the fixed line "Data to raise with a
   physician, never a diagnosis."
7. **Memory-repo integration is cross-linking.** The section links a member to their wiki
   page (`wiki/projects/family-health-tracker/<slug>.md`) by a deterministic slug of the
   folder name and only when that file exists; the page itself is read through the
   existing docs API. No second parser over the memory repo.

## Consequences

- New config: `HEALTH_REPO_ROOT` (default unset) and `FAMILY_HEALTH_ALLOW_PROXY`
  (default `false`); `/api/status` reports `familyHealthConfigured` and
  `familyHealthAllowProxy`. The VPS deployment leaves both unset.
- Verification (performed, not recommended) must assert: unset root → 404; traversal and
  out-of-root → 400; docs API cannot read the health root; proxied request → 403 by
  default and 200 only with the flag; the flag without a root or without a proxy refuses
  startup; a health root inside the memory repo refuses startup.
- Test fixtures use invented members and values. Real family data never enters this
  repository, its tests, screenshots, commit messages, or memory captures about this work.
- The console has a "Memory Health" section (lint cadence, `metrics.health`). The new
  domain is named **Family Health** everywhere (`familyHealth`, `family-health`) so the
  two never conflate.

## Amendment — served on the owner's tailnet (2026-09-17)

The owner decided, the same day, to serve Family Health through the authenticated proxy
at `aos-console.home.arpa`. Grounds stated by the owner: only their own devices are on
the tailnet. The deployment therefore sets `HEALTH_REPO_ROOT` to the host's private
clone and `FAMILY_HEALTH_ALLOW_PROXY=true` in `/etc/aos-console/console.env`;
`deploy/setup-vps.sh` writes both when the clone is present on the host.

What does **not** change: the listener stays loopback; the proxy secret and Caddy basic
auth still gate every request first; `/api/family-health/*` still refuses the proxy
hostname when the flag is absent; `EXPOSE_RAW_CONTENT` stays off; no binaries are served;
decisions 1, 2, 4, 5, 6 and 7 stand. The effective audience for identifiable medical data
is now every holder of the console's basic-auth password inside the tailnet, so the
password and the tailnet's device list are the boundary. Re-verify both before adding a
device or sharing the password, in the same spirit as the tracker's point-in-time
repository access checks.
