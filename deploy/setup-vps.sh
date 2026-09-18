#!/usr/bin/env bash
# Serves the Agentic OS web console at http://aos-console.home.arpa on this
# tailnet host: builds the dashboard, installs the systemd service, the Caddy
# site block (with basic auth + proxy secret), and the AdGuard DNS rewrite.
#
# Safe to re-run: the proxy secret and the basic-auth account are kept unless
# --reset-password is given; the Caddyfile is backed up and the console block
# is replaced between its markers; the rewrite is added only if missing.
#
#   deploy/setup-vps.sh [--reset-password]

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM="$(cd "$HERE/../platform" && pwd)"
NAME="aos-console.home.arpa"
PORT=8084
REPO_ROOT="/home/joaquin/projects/agentic-os"
ANSWER="100.93.128.49"
ADGUARD="http://100.93.128.49:8080"
ENV_FILE="/etc/aos-console/console.env"
# Family Health (ADR-0010, amendment 2026-09-17): the owner chose to serve the
# section on the tailnet because only their own devices are on it. Written
# only when the private clone is present on this host.
HEALTH_REPO_ROOT="/home/joaquin/projects/Health-Management"
# ADR-0011: loopback, never finances.home.arpa (that name routes out to Caddy
# and back). FIREFLY_PUBLIC_URL is browser-facing link config only.
FIREFLY_URL="http://127.0.0.1:8081"
FIREFLY_PUBLIC_URL="http://finances.home.arpa"
USERS_FILE="/etc/caddy/aos-console-users.caddy"
PROXY_FILE="/etc/caddy/aos-console-proxy.caddy"
CADDYFILE="/etc/caddy/Caddyfile"
RESET_PASSWORD=false
[[ "${1:-}" == "--reset-password" ]] && RESET_PASSWORD=true

# ---------------------------------------------------------------- Build ----
echo "==> Installing dependencies and building the dashboard"
(cd "$PLATFORM" && npm ci --no-audit --no-fund && npm run build)

# ---------------------------------------------------------- Proxy secret ----
echo
echo "==> Console environment ($ENV_FILE)"
SECRET=""
if sudo test -f "$ENV_FILE"; then
	SECRET="$(sudo sed -n 's/^PROXY_SECRET=//p' "$ENV_FILE")"
fi
if [[ -z "$SECRET" ]]; then
	SECRET="$(openssl rand -hex 32)"
	echo "    generated a new proxy secret"
else
	echo "    keeping the existing proxy secret"
fi

FAMILY_HEALTH_LINES=""
if [[ -d "$HEALTH_REPO_ROOT/members" ]]; then
	FAMILY_HEALTH_LINES=$'HEALTH_REPO_ROOT='"$HEALTH_REPO_ROOT"$'\nFAMILY_HEALTH_ALLOW_PROXY=true'
	echo "    family health: serving $HEALTH_REPO_ROOT through the proxy (ADR-0010 amendment)"
else
	echo "    family health: clone not found at $HEALTH_REPO_ROOT — section left off"
fi

# Finance (ADR-0011). This file is rewritten wholesale, so the token is carried
# over from the previous deployment, falling back to the developer's
# platform/.env the first time. FIREFLY_URL stays loopback: the token must
# never cross a network, and Caddy already fronts finances.home.arpa here.
FINANCE_LINES=""
FIREFLY_TOKEN=""
if sudo test -f "$ENV_FILE"; then
	FIREFLY_TOKEN="$(sudo sed -n 's/^FIREFLY_TOKEN=//p' "$ENV_FILE")"
fi
if [[ -z "$FIREFLY_TOKEN" && -f "$HERE/../platform/.env" ]]; then
	FIREFLY_TOKEN="$(sed -n 's/^FIREFLY_TOKEN=//p' "$HERE/../platform/.env")"
fi
if [[ -n "$FIREFLY_TOKEN" ]]; then
	FINANCE_LINES=$'FIREFLY_URL='"$FIREFLY_URL"$'\nFIREFLY_TOKEN='"$FIREFLY_TOKEN"$'\nFIREFLY_PUBLIC_URL='"$FIREFLY_PUBLIC_URL"$'\nFINANCE_ALLOW_PROXY=true'
	echo "    finance: serving $FIREFLY_URL through the proxy (ADR-0011 amendment)"
else
	echo "    finance: no Firefly token found — section left off"
fi

sudo install -d -m 755 -o root -g root /etc/aos-console
sudo install -m 640 -o root -g joaquin /dev/stdin "$ENV_FILE" <<ENV
HOST=127.0.0.1
PORT=$PORT
REPO_ROOT=$REPO_ROOT
PROXY_HOSTNAME=$NAME
PROXY_SECRET=$SECRET
$FAMILY_HEALTH_LINES
$FINANCE_LINES
ENV

# --------------------------------------------------------------- Service ----
echo
echo "==> Installing aos-console.service"
sudo install -m 644 -o root -g root "$HERE/aos-console.service" /etc/systemd/system/aos-console.service
sudo systemctl daemon-reload
sudo systemctl enable aos-console.service >/dev/null
sudo systemctl restart aos-console.service

for _ in $(seq 1 20); do
	curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/status" && break
	sleep 0.5
done
if ! curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/status"; then
	echo "    !! console did not come up; see: journalctl -u aos-console -n 50" >&2
	exit 1
fi
echo "    console listening on 127.0.0.1:$PORT"

# ----------------------------------------------------------------- Caddy ----
echo
echo "==> Installing the Caddy site block"

PASSWORD=""
if $RESET_PASSWORD || ! sudo test -f "$USERS_FILE"; then
	read -r -p "    console username [joaquin]: " AUTH_USER
	AUTH_USER="${AUTH_USER:-joaquin}"
	while true; do
		read -r -s -p "    console password: " PASSWORD; echo
		read -r -s -p "    repeat password:  " PASSWORD2; echo
		[[ -n "$PASSWORD" && "$PASSWORD" == "$PASSWORD2" ]] && break
		echo "    passwords empty or different, try again"
	done
	HASH="$(printf '%s\n%s\n' "$PASSWORD" "$PASSWORD" | caddy hash-password)"
	printf '\t%s %s\n' "$AUTH_USER" "$HASH" | sudo install -m 640 -o root -g caddy /dev/stdin "$USERS_FILE"
	echo "    basic-auth account written"
else
	AUTH_USER="$(sudo awk '{print $1; exit}' "$USERS_FILE")"
	echo "    keeping existing basic-auth account ($AUTH_USER); --reset-password to change"
fi

printf '\theader_up X-AOS-Proxy-Auth "%s"\n' "$SECRET" | sudo install -m 640 -o root -g caddy /dev/stdin "$PROXY_FILE"

STAMP="$(date +%Y%m%d-%H%M%S)"
sudo cp -a "$CADDYFILE" "$CADDYFILE.bak.$STAMP"
echo "    backed up to $CADDYFILE.bak.$STAMP"

# Drop any previous console block, then append the current one.
NEW="$(mktemp)"
sudo awk '/^# >>> aos-console$/{skip=1} !skip{print} /^# <<< aos-console$/{skip=0}' "$CADDYFILE" |
	sed -e :a -e '/^\n*$/{$d;N;ba' -e '}' >"$NEW"
{ echo; cat "$HERE/Caddyfile.snippet"; } >>"$NEW"
sudo install -m 644 -o root -g root "$NEW" "$CADDYFILE"
rm -f "$NEW"

if ! sudo caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
	echo "    !! config invalid, rolling back" >&2
	sudo cp -a "$CADDYFILE.bak.$STAMP" "$CADDYFILE"
	exit 1
fi

sudo systemctl reload caddy
echo "    caddy reloaded"

# --------------------------------------------------------------- AdGuard ----
echo
echo "==> Adding the AdGuard rewrite $NAME -> $ANSWER"
echo "    (AdGuard Home admin login, the same one you use at $ADGUARD)"

read -r -p "    username: " AGH_USER
read -r -s -p "    password: " AGH_PASS
echo

api() {
	curl -sS -u "$AGH_USER:$AGH_PASS" -H 'Content-Type: application/json' "$@"
}

if api "$ADGUARD/control/rewrite/list" | grep -q "\"$NAME\""; then
	echo "    rewrite already present, leaving it alone"
else
	api -X POST "$ADGUARD/control/rewrite/add" \
		-d "{\"domain\":\"$NAME\",\"answer\":\"$ANSWER\"}" >/dev/null
	echo "    rewrite added"
fi

# ---------------------------------------------------------------- Verify ----
echo
echo "==> Verifying"
printf '    DNS  %s -> %s\n' "$NAME" "$(dig +short @"$ANSWER" "$NAME" | tr '\n' ' ')"
printf '    HTTP no credentials       -> %s (want 401)\n' \
	"$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $NAME" http://127.0.0.1:80/api/status)"
printf '    HTTP direct, no secret    -> %s (want 403)\n' \
	"$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $NAME" "http://127.0.0.1:$PORT/api/status")"
if [[ -n "$PASSWORD" ]]; then
	printf '    HTTP with credentials     -> %s (want 200)\n' \
		"$(curl -s -o /dev/null -w '%{http_code}' -u "$AUTH_USER:$PASSWORD" -H "Host: $NAME" http://127.0.0.1:80/api/status)"
fi
echo
echo "Done. Open http://$NAME from any tailnet device."
