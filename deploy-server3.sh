#!/usr/bin/env bash
# Server 3 (Lane Relay only) — one bundled relay.js, no bot/login/session/database
# Tasks: build the single-file relay bundle, prove it carries no forbidden
#        dependency, switch the release, restart the unit, verify every lane is
#        ready, and keep a rollback pointer the whole time.
# Usage: bash deploy-server3.sh
# Note:  Reaches Server 3 directly on its public IP (Linode / Tokyo). Login and
#        control traffic never touch this box — see deploy/server3/README.md.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
KEY_PATH="${KEY_PATH:-$HOME/.ssh/linode_bot_deploy}"
TARGET="${TARGET:-root@172.105.237.118}"
RELEASE_BASE="/opt/linebot-relay/releases"
CURRENT_LINK="/opt/linebot-relay/current"
SERVICE="linebot-lane-relay.service"
# The relay binds its WireGuard tunnel address, not loopback, so the box can
# health-check itself here. Matches deploy/server2/worker-topology.example.json.
HEALTH_URL="${HEALTH_URL:-http://10.90.0.2:8795/healthz}"
# Seconds to wait for all 32 legy lanes to prime from a cold restart before
# rolling back. 20s (the old value) rolled back healthy deploys on a slow warm.
HEALTH_TRIES="${HEALTH_TRIES:-60}"

SSH_OPTS=(-i "$KEY_PATH" -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=10)

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_debug() { echo -e "${BLUE}[DEBUG]${NC} $1"; }

log_info "=== Server 3 Deploy Script (lane relay) ==="
log_info "Target:        $TARGET"
log_info "Release base:  $RELEASE_BASE"
log_info "Current link:  $CURRENT_LINK"
log_info "Health URL:    $HEALTH_URL"
log_info ""

# Confirm action
read -r -p "Proceed with build + deploy to Server 3 (lane relay)? [y/N] " confirm
[[ "$confirm" == "y" || "$confirm" == "Y" ]] || { log_error "Aborted"; exit 1; }

# Verify SSH key
if [ ! -f "$KEY_PATH" ]; then
	log_error "SSH key not found at: $KEY_PATH"
	log_error "Set KEY_PATH=/path/to/key, or place the Linode deploy key there."
	exit 1
fi

# The relay ships only reviewed, committed code — see SESSION-HANDOFF-FASTEST-LANE.md
# ("ห้าม deploy worktree ที่ยังไม่ commit"). This is deliberate policy, not a
# convenience check: unlike Server 1 / Server 2 there is no temp-index escape
# hatch here.
if ! git -C "$ROOT_DIR" diff --quiet || ! git -C "$ROOT_DIR" diff --cached --quiet; then
	log_error "Refusing Server 3 deploy: commit the working tree first."
	exit 1
fi

SHA="$(git -C "$ROOT_DIR" rev-parse --short HEAD)"
RELEASE_ID="$(date -u +%Y%m%d-%H%M%S)-${SHA}"
REMOTE_RELEASE="$RELEASE_BASE/$RELEASE_ID"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf -- "$BUILD_DIR"' EXIT

log_info "==> Step 1: Build the single-file relay bundle ($RELEASE_ID)"
(
	cd "$ROOT_DIR/backend"
	bun build src/relay/index.ts --target=bun --minify --outfile="$BUILD_DIR/relay.js"
)
log_info "Bundle size: $(ls -lah "$BUILD_DIR/relay.js" | awk '{print $5}')"

log_info "==> Step 2: Prove the bundle carries no bot/login/database dependency"
if grep -aEq 'session-manager|client/login|auth/session|sqlite\.ts|worker\.db|app\.db' "$BUILD_DIR/relay.js"; then
	log_error "Refusing Server 3 deploy: relay bundle contains a forbidden bot/login/database dependency."
	exit 1
fi
log_info "Isolation check passed."

log_info "==> Step 3: Record rollback target on Server 3"
# -n: this call has no input of its own; without it ssh competes with the
# script's earlier `read -r -p` for stdin (the Server 2 script hit exactly this).
ssh -n "${SSH_OPTS[@]}" "$TARGET" \
	'readlink -f /opt/linebot-relay/current > ~/.rollback_to.txt 2>/dev/null || true; cat ~/.rollback_to.txt 2>/dev/null || echo "(no current release yet — first deploy)"'

log_info "==> Step 4: Transfer bundle + unit file"
ssh "${SSH_OPTS[@]}" "$TARGET" "install -d -o linebot-relay -g linebot-relay '$REMOTE_RELEASE'"
scp "${SSH_OPTS[@]}" -q "$BUILD_DIR/relay.js" "$TARGET:$REMOTE_RELEASE/relay.js"
scp "${SSH_OPTS[@]}" -q "$ROOT_DIR/deploy/server3/linebot-lane-relay.service" "$TARGET:/etc/systemd/system/$SERVICE"

log_info "==> Step 5: Switch release, restart, verify every lane is ready"
# Quoted heredoc + positional args: no local expansion, nothing to escape, and
# a stray quote in a path can never break the remote script.
ssh "${SSH_OPTS[@]}" "$TARGET" bash -s -- \
	"$REMOTE_RELEASE" "$CURRENT_LINK" "$SERVICE" "$HEALTH_URL" "$HEALTH_TRIES" <<'REMOTE'
set -euo pipefail

RELEASE_DIR="$1"
CURRENT_LINK="$2"
SERVICE="$3"
HEALTH_URL="$4"
HEALTH_TRIES="$5"
HEALTH_FILE=/tmp/linebot-relay-health.json

ROLLBACK_TARGET="$(cat ~/.rollback_to.txt 2>/dev/null || true)"

rollback() {
	if [ -n "$ROLLBACK_TARGET" ] && [ -d "$ROLLBACK_TARGET" ]; then
		echo "--- Rolling back: $CURRENT_LINK -> $ROLLBACK_TARGET ---"
		ln -sfn "$ROLLBACK_TARGET" "$CURRENT_LINK"
		systemctl restart "$SERVICE" \
			|| echo "--- CRITICAL: release pointer rolled back but restart failed — manual recovery needed ---"
	else
		echo "--- No valid previous release to roll back to ---"
		echo "--- New release stays symlinked; the relay may be down — investigate on the box ---"
	fi
}

echo "--- Installing release $RELEASE_DIR ---"
chown -R linebot-relay:linebot-relay "$RELEASE_DIR"
chmod 0550 "$RELEASE_DIR/relay.js"
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true

echo "--- Restarting $SERVICE ---"
if ! systemctl restart "$SERVICE"; then
	echo "--- RESTART FAILED — rolling back ---"
	rollback
	exit 1
fi

# /healthz answers 200 only when origins.every(ready > 0 && ready === total) —
# see backend/src/relay/dispatch-route.ts. A 200 is itself the readiness proof;
# the bun one-liner below is a best-effort pretty print of the per-origin counts
# and never gates the deploy (the box always has /usr/local/bin/bun).
lane_readiness() {
	/usr/local/bin/bun -e '
const d = JSON.parse(await Bun.file(process.argv[1]).text());
for (const o of d.origins ?? []) console.log(`    ${o.origin}: ${o.ready}/${o.total} ready`);
' "$HEALTH_FILE" 2>/dev/null || true
}

echo "--- Verifying relay health at $HEALTH_URL (up to ${HEALTH_TRIES}s) ---"
for i in $(seq 1 "$HEALTH_TRIES"); do
	code="$(curl -s -o "$HEALTH_FILE" -w '%{http_code}' --max-time 4 "$HEALTH_URL" || echo 000)"
	if [ "$code" = "200" ]; then
		echo "--- Relay healthy: every configured lane is ready ---"
		lane_readiness
		exit 0
	fi
	if [ $((i % 10)) -eq 0 ]; then
		echo "    still warming lanes (attempt $i/$HEALTH_TRIES, last HTTP $code)"
		lane_readiness
	fi
	sleep 1
done

echo "--- Relay did not reach full readiness in ${HEALTH_TRIES}s — rolling back ---"
rollback
exit 1
REMOTE

log_info "==> Step 6: Post-deploy status"
ssh "${SSH_OPTS[@]}" "$TARGET" bash -s -- "$CURRENT_LINK" "$SERVICE" "$HEALTH_URL" <<'STATUS'
set -uo pipefail

CURRENT_LINK="$1"
SERVICE="$2"
HEALTH_URL="$3"

echo "--- Current release ---"
ls -la "$CURRENT_LINK" 2>&1 | head -1

echo ""
echo "--- Service ---"
systemctl is-active "$SERVICE" 2>&1 || true
systemctl status "$SERVICE" --no-pager -l 2>&1 | head -8 || true

echo ""
echo "--- Listener (expect :8795) ---"
ss -tlnp 2>/dev/null | grep -E ':8795[[:space:]]' || echo "  (no listener on 8795)"

echo ""
echo "--- Health snapshot ---"
curl -s --max-time 5 "$HEALTH_URL" 2>&1 | head -c 500 || true
echo ""
STATUS

echo ""
log_info "=== Server 3 Deploy Complete ($RELEASE_ID) ==="
echo ""
echo "Rollback command (if needed):"
echo "  ssh -i $KEY_PATH $TARGET 'ln -sfn \$(cat ~/.rollback_to.txt) $CURRENT_LINK && systemctl restart $SERVICE'"
echo ""
