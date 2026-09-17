# VPS deployment — aos-console.home.arpa

Serves the console on the tailnet at http://aos-console.home.arpa, next to Firefly III
(`finances.home.arpa`), Paperless-ngx (`docs.home.arpa`) and SparkyFitness
(`fitness.home.arpa`).

## Layout

| Piece                        | Where                                        | Notes                                               |
|------------------------------|----------------------------------------------|-----------------------------------------------------|
| `aos-console.service`        | `/etc/systemd/system/`                       | `node server/src/index.js` as `joaquin`, bound `127.0.0.1:8084` |
| `console.env`                | `/etc/aos-console/` (640 root:joaquin)       | `HOST`, `PORT`, `REPO_ROOT`, `PROXY_HOSTNAME`, `PROXY_SECRET` |
| `Caddyfile.snippet`          | appended to `/etc/caddy/Caddyfile`           | Between `# >>> aos-console` / `# <<< aos-console` markers |
| `aos-console-users.caddy`    | `/etc/caddy/` (640 root:caddy)               | Basic-auth account (bcrypt)                         |
| `aos-console-proxy.caddy`    | `/etc/caddy/` (640 root:caddy)               | `header_up X-AOS-Proxy-Auth "<PROXY_SECRET>"`       |
| AdGuard rewrite              | `aos-console.home.arpa → 100.93.128.49`      | Tailscale IP, same reasoning as `docs.home.arpa`    |

The memory repo is read live from `/home/joaquin/projects/agentic-os`.

## Why it looks different from the Docker apps

Firefly and Paperless have their own logins. The console has none, and it exposes memory
contents, so ADR-0005 forbids serving it beyond localhost without auth. The amendment of
2026-09-17 allows exactly this setup:

1. The Node process still binds loopback only.
2. Caddy requires basic auth on every path.
3. Caddy injects a secret header. The API accepts `Host: aos-console.home.arpa` only
   with that secret, so the name cannot be used by DNS rebinding or by anything that
   reaches `127.0.0.1:8084` directly.
4. Raw content stays hidden (`EXPOSE_RAW_CONTENT` unset). Authenticated users can start
   the allowlisted checks (`npm run verify`, `check:*`) behind dry-run + confirm.

## Install / update

```bash
cd /home/joaquin/projects/Agentic-OS-Web-console
git pull
deploy/setup-vps.sh                  # first run prompts for a console password + AdGuard login
deploy/setup-vps.sh --reset-password # change the console password
```

The script builds the dashboard, (re)installs the service and Caddy block, keeps the
existing proxy secret and account, validates Caddy before reloading (rolling back on
failure), and checks for a 401 without credentials and a 403 when the secret is missing.

For a code-only update, `npm ci && npm run build` in `platform/` then
`sudo systemctl restart aos-console` is enough.

## Operations

```bash
systemctl status aos-console
journalctl -u aos-console -f
sudo systemctl restart aos-console
```

## Caveats

- `sparkyfitness/Caddyfile.snippet` and `paperless-ngx/Caddyfile.snippet` are full copies
  of `/etc/caddy/Caddyfile`. Installing one of them again drops the console block; re-run
  `deploy/setup-vps.sh` afterwards.
- Plain HTTP, like the other `.home.arpa` apps. The name resolves to the Tailscale IP, so
  basic-auth credentials travel inside WireGuard; they are only readable on the host itself.
- Every tailnet device can *reach* the login prompt; only the password protects the data.
