# Agentic OS Web Console (Odysseus)

A **localhost-only private console** over the Agentic OS memory repo: canonical memory
metrics, docs browsing, and workflow/skill registries, read **live** from the filesystem.
Express backend (`server/`) + React/Vite frontend (`dashboard/`), npm workspaces.

**This console is not safe for LAN/public exposure without auth.** The server binds
loopback by default and refuses to start on a non-loopback `HOST` (no auth layer exists
in Phase 1) — see ADR-0005.

## Commands (run from `platform/`)

| Command          | What it does                                              |
| ---------------- | --------------------------------------------------------- |
| `npm install`    | Install both workspaces                                    |
| `npm run dev`    | Server on `:3001` (watch) + Vite dev server (`/api` proxy) |
| `npm run build`  | Build the dashboard to `dashboard/dist/`                   |
| `npm start`      | Serve API + built dashboard on `http://127.0.0.1:3001`     |
| `npm test`       | In-process API tests (Seam 1: exported `app`, no bind)     |
| `npm run verify` | Boot smoke (Seam 2: real startup, bind + guard checks)     |

## Configuration (env)

| Var                  | Default                          | Notes                                                        |
| -------------------- | -------------------------------- | ------------------------------------------------------------ |
| `PORT`               | `3001`                           |                                                              |
| `HOST`               | `127.0.0.1`                      | Non-loopback without auth **fails startup** (ADR-0005)       |
| `REPO_ROOT`          | `../../..` from `server/src/`    | Path to the Agentic OS memory repo. Set explicitly when developing outside it (e.g. `REPO_ROOT=~/agents/agentic-os`) |
| `EXPOSE_RAW_CONTENT` | `false`                          | Gates raw **content** over HTTP only; raw metrics always computed (ADR-0005) |

## Security model (Phase 1)

- Loopback bind (`listen(PORT, HOST)`, default `127.0.0.1`); non-loopback `HOST`
  without configured auth is **invalid configuration** — startup fails non-zero.
- The API validates the `Host` header against loopback hosts and rejects cross-origin
  `Origin`s (DNS-rebinding defense). No permissive CORS.
- `POST /api/operations/:id/run` and `/dry-run` return `501` until Phase 3.
- Client-supplied paths go through `paths.safeResolve` (rejects `..`, absolute paths,
  anything outside the allowed roots). Path safety prevents reading outside the roots;
  it does **not** make the roots safe to expose — those are two different problems.
