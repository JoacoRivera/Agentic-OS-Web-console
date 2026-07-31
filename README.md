# Agentic OS Web Console

Agentic OS Web Console, also called Odysseus, is a localhost-only private console
for the Agentic OS memory repo. It reads the live filesystem and presents memory
metrics, documentation browsing, workflow and skill registries, guided operations,
controlled local checks, and an audit log.

The app is an npm workspace under `platform/`:

- `platform/server`: Express API that reads the Agentic OS memory repo.
- `platform/dashboard`: React/Vite dashboard that consumes the API.
- `platform/scripts`: local verification and recount scripts used by the console.

This console is not safe for LAN or public exposure without an auth layer. It binds
to loopback by default and refuses to start on a non-loopback host while auth is not
configured.

## Requirements

- Node.js 22.9 or newer.
- npm.
- A local Agentic OS memory repository. By default this project expects it at
  `~/agents/agentic-os` via `platform/.env`.

## Setup

Run commands from `platform/` unless noted otherwise.

```bash
cd platform
cp .env.example .env
npm install
npm run dev
```

Open the Vite URL printed by the dev server. The API runs on
`http://127.0.0.1:3001` by default, and the dashboard dev server proxies `/api`
requests to it.

For a production-style local run:

```bash
cd platform
npm run build
npm start
```

Then open `http://127.0.0.1:3001`.

### Windows login startup

For a WSL installation, run the console as an enabled systemd service and use a
per-user Windows Startup launcher to wake the distro. The idempotent Windows half is:

```powershell
.\platform\scripts\setup-windows-autostart.ps1
```

It creates a hidden Startup launcher and verifies the configured console URL.
No administrator access or hosts-file change is needed because `.localhost`
names resolve to loopback automatically. The server must also set
`LOCAL_HOSTNAME=agentic-os-console.localhost`; use `PORT=80` when the URL should
not include a port. The launcher keeps one explicit WSL process alive because
systemd services alone do not prevent WSL from idle-terminating.

## Configuration

`npm run dev`, `npm start`, `npm run verify`, and live-repo checks load
`platform/.env` when it exists.

| Variable | Default | Purpose |
| --- | --- | --- |
| `REPO_ROOT` | `../../..` from `platform/server/src` | Path to the Agentic OS memory repo. Use `~/agents/agentic-os` when this console is checked out separately. |
| `PORT` | `3001` | Express server port. |
| `HOST` | `127.0.0.1` | Bind host. Non-loopback hosts fail startup because no auth layer exists. |
| `LOCAL_HOSTNAME` | unset | One explicit local browser alias. Prefer a `.localhost` name, which resolves to loopback automatically. |
| `EXPOSE_RAW_CONTENT` | `false` | Allows raw memory content over HTTP when `true`. Raw metrics are always computed. |
| `AUDIT_LOG_PATH` | `platform/logs/operations.log` | JSONL audit log for controlled executable operations. |
| `AUDIT_ROTATE_BYTES` | `1000000` | Audit log rollover size. |
| `AUDIT_ROTATE_KEEP` | `3` | Number of rotated audit logs to keep. |

## Main Features

- Overview and memory health: live memory metrics from the filesystem.
- Documentation explorer: browse, read, search, and inspect backlinks for memory docs.
- Workflow registry: scan `wiki/workflows/**/*.md`, flag objective defects, and keep
  `Unclassified` as a first-class status when `workflow_kind` is missing.
- Skill registry: scan installed Agentic OS skills and provide copyable invocations.
- Review queue and activity: surface drafts, recent changes, and health signals.
- Operations: guided checklists for LLM/human workflows plus a small allowlist of
  deterministic checks that can be run locally through the console.
- Audit log: view completed executable operation runs and their captured output.

LLM skills are never executed by the console. Skill-backed operations are guided-only:
the UI can show a checklist and command preview, but the human runs the LLM skill.

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | Install both workspaces. |
| `npm run dev` | Run the Express server in watch mode and the Vite dashboard dev server. |
| `npm run build` | Build the dashboard into `platform/dashboard/dist/`. |
| `npm start` | Serve the API and built dashboard from `http://127.0.0.1:3001`. |
| `npm test` | Run in-process server API tests. |
| `npm run verify` | Boot smoke test with real bind and startup guard checks. |
| `npm run check:paths` | Verify path traversal, absolute path, and out-of-root rejections. |
| `npm run check:docs` | Check docs tree, file reads, search, backlinks, and raw content gating against the live repo. |
| `npm run check:workflows` | Check workflow registry inclusion and status rollups against an independent recount. |
| `npm run check:skills` | Check the skill registry against an independent directory recount. |
| `npm run check:metrics-groundtruth` | Compare `/api/metrics` to an independent filesystem recount. |

## API Overview

The dashboard uses these localhost API routes:

- `GET /api/status`: runtime status and effective configuration summary.
- `GET /api/metrics`: canonical Agentic OS memory metrics.
- `GET /api/docs/tree`: documentation tree for the memory repo.
- `GET /api/docs/file?path=...`: read a safe markdown path.
- `GET /api/docs/search?q=...`: search docs; raw snippets require
  `EXPOSE_RAW_CONTENT=true`.
- `GET /api/docs/backlinks?path=...`: find links to a doc.
- `GET /api/workflows`: workflow registry.
- `GET /api/workflow?path=...`: workflow detail by path.
- `GET /api/skills`: skill registry.
- `GET /api/operations`: guided and executable operation catalog.
- `POST /api/operations/:id/dry-run`: prepare an executable operation and issue a
  short-lived confirmation token.
- `POST /api/operations/:id/run`: run an allowlisted executable operation after
  dry-run confirmation.
- `GET /api/operations/runs/:runId`: read an operation run snapshot.
- `GET /api/operations/runs/:runId/events`: stream operation output with SSE.
- `GET /api/audit`: tail the operation audit log.

## Controlled Operations

Executable operations are intentionally narrow. The server maps known ids to fixed
`npm run ...` commands and runs them with `spawn()` and `shell: false`; client input
selects an allowlisted row and is never interpolated into a shell command.

Run flow:

1. Dry-run returns the exact command, cwd, and a single-use confirmation token.
2. Run requires `{"confirm": true, "confirmToken": "..."}`.
3. Only one operation runs at a time.
4. Output is available through run snapshots and SSE events.
5. Completion appends one JSON line to the audit log, including status, changed-file
   signals, output tail, and exit code.

## Metrics Notes

`GET /api/metrics` is the canonical memory metrics implementation. It performs a live
filesystem scan per request over `wiki/`, `raw/`, and `templates/`. The permanent
correctness check is `npm run check:metrics-groundtruth`.

Important metric terms:

- `wikiN`: published long-term memory under `wiki/`.
- `rawN`: append-only raw capture archive, not a backlog.
- `all`: Markdown-file count across `wiki/`, `raw/`, and `templates/`, excluding
  `_template`; do not treat it as total memory.
- `knowledgeN` and the 30-day growth series: distinct knowledge-intake sources, keyed on
  explicit frontmatter lineage (`source_id` + `knowledge_intake_date` on an origin,
  `promoted_from` on a derived page). A raw→wiki promotion resolves to its origin and adds
  no intake event. There is no Git or mtime fallback: files without valid lineage are
  excluded, never guessed (ADR-0003).
- `lineage`: coverage of that keying — `eligibleN` / `lineagedN` / `unlineagedN` /
  `invalidN` / `promotedN` plus conflicting- and future-dated-source counts.
  `lineage.problems` exposes at most 20 deterministic `{path, reason}` diagnostics,
  ordered by reason then path, and never includes file content. Stable reason codes are
  `invalid-frontmatter`, `missing-lineage`, `partial-origin`, `origin-and-promotion`,
  `invalid-source-id`, `invalid-intake-date`, `future-intake-date`,
  `conflicting-source-id`, `unsafe-promoted-from`, `missing-promoted-from`,
  `invalid-promoted-from-lineage`, `promotion-cycle`, and `unreadable-file`. Until the
  memory repo is fully backfilled, `knowledgeN` is a floor, not total memory.

`knowledge_intake_date` must be written as a bare `YYYY-MM-DD` calendar day. YAML would
otherwise quietly accept `2026-07-14T09:30:00Z` as a date and turn `2026-02-30` into
March 2, so the console validates the exact frontmatter source text and counts timestamps,
quoted dates, comments, and invalid calendar days as invalid lineage.

## Security Model

- The server binds to `127.0.0.1` by default.
- `HOST=0.0.0.0` or other non-loopback values fail startup because no auth layer exists.
- API requests are guarded by loopback `Host` validation plus, when configured,
  one explicit local `LOCAL_HOSTNAME`; cross-origin `Origin`s are rejected.
  There is no permissive CORS.
- Raw memory content is hidden by default. Set `EXPOSE_RAW_CONTENT=true` only when you
  explicitly want raw markdown bodies/snippets exposed to the local browser.
- Path reads use safe path resolution to reject traversal and out-of-root access. This is
  path safety, not access control.

## Project Docs

- [Platform README](platform/README.md) has detailed implementation notes.
- [Domain context](docs/CONTEXT.md) defines the Agentic OS vocabulary used by the UI.
- [ADRs](docs/adr/) record design decisions for metrics, security, workflow status, and
  operation execution.
