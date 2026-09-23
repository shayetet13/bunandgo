#!/usr/bin/env bash
# Server 2 (Real Backend) — Bun backend + Node.js processes
# Tasks: restart services, deploy, health check, test suite
# Usage: bash deploy-server2.sh
# Note: Reaches Server 2 via ProxyJump through Server 1

set -euo pipefail

SSH_KEY="$(dirname "$0")/maxpc.pem"
# Prefer the stable operator key. Fall back to the repository-local copy only
# on older workstations that have not installed it under ~/.ssh yet.
KEY_PATH="${KEY_PATH:-/c/Users/Administrator/.ssh/linebot-maxpc.pem}"
GATEWAY="admin@3.112.61.130"
TARGET_HOST="linebot@10.77.0.2"
TARGET_IP="10.77.0.2"
RELEASE_BASE="/opt/linebot/releases"
CURRENT_LINK="/opt/linebot/current"
SHARED_DB="/opt/linebot/shared/worker.db"
SERVICE_NAME="linebot-worker"

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

log_info "=== Server 2 Deploy & Restart Script ==="
log_info "Target: $TARGET_HOST (real backend)"
log_info "Gateway: $GATEWAY (via ProxyJump)"
log_info "Release base: $RELEASE_BASE"
log_info "Current symlink: $CURRENT_LINK"
log_info ""

# Confirm action
read -r -p "Proceed with full restart and deploy to Server 2? [y/N] " confirm
[[ "$confirm" == "y" || "$confirm" == "Y" ]] || { log_error "Aborted"; exit 1; }

# Verify SSH key exists in space-free path
if [ ! -f "$KEY_PATH" ]; then
	log_error "SSH key not found at: $KEY_PATH"
	log_info "Copying key to space-free path..."
	mkdir -p "$(dirname "$KEY_PATH")"
	cp "$SSH_KEY" "$KEY_PATH"
	chmod 600 "$KEY_PATH"
fi

log_info "==> Step 1: Record rollback target"

# Captured first, before anything else touches the release, so a failure at
# any later step still leaves a valid pointer. The previous version of this
# script wrote this after the test step; when tests failed, `set -e` ended
# the script right there and the file was never written — the 2026-08-09
# incident had to recover by guessing the previous release from `ls -t`
# instead of reading a saved pointer.
## -n: this call needs no input of its own, and without it ssh competes with
## the script's later `read -r -p` for the same piped stdin — it silently
## consumed the confirmation meant for the "uncommitted changes" prompt below
## and the script exited on an empty answer with no visible error.
ssh -n -i "$KEY_PATH" \
	-o StrictHostKeyChecking=no \
	-o ConnectTimeout=10 \
	-o ProxyCommand="ssh -i $KEY_PATH -W $TARGET_IP:22 $GATEWAY" \
	"$TARGET_HOST" 'readlink -f /opt/linebot/current > ~/.rollback_to.txt && cat ~/.rollback_to.txt'

log_info "==> Step 2: Prepare Deploy Package"

DEPLOY_TS=$(date +%Y%m%d-%H%M%S)
DEPLOY_ID="${DEPLOY_TS}-deploy"

log_info "Deploy ID: $DEPLOY_ID"
log_info "Packaging the tested working tree without changing the real Git index..."
cd "$(dirname "$0")"
# A production hotfix is often deliberately uncommitted while it is being
# verified. The old script silently archived HEAD and therefore deployed none
# of the code that had just passed tests. Build a temporary index instead:
# tracked edits plus the explicitly reviewed new source files, never arbitrary
# untracked binaries/dumps from the workspace.
TEMP_INDEX=$(mktemp)
cp "$(git rev-parse --git-path index)" "$TEMP_INDEX"
GIT_INDEX_FILE="$TEMP_INDEX" git add -u
for new_file in \
	ARCHITECTURE.md \
	backend/src/api/forwarded-events.ts \
	backend/src/api/routes/system.ts \
	backend/src/api/routes/system.test.ts \
	backend/src/bot/square-poll-quiet.ts \
	backend/src/bot/square-poll-quiet.test.ts \
	backend/src/bot/start-confirmation.test.ts \
	backend/src/bot/maintenance-mode.ts \
	backend/src/announcements/announcements.ts \
	backend/src/announcements/announcements.test.ts \
	backend/src/api/routes/announcements.ts \
	frontend/src/lib/rule-input.ts \
	frontend/src/lib/rule-input.test.ts \
	frontend/src/lib/chat-category.ts \
	frontend/src/lib/chat-category.test.ts \
	frontend/src/lib/scheduled-post-order.ts \
	frontend/src/lib/scheduled-post-order.test.ts
do
	[ ! -f "$new_file" ] || GIT_INDEX_FILE="$TEMP_INDEX" git add -- "$new_file"
done
DEPLOY_TREE=$(GIT_INDEX_FILE="$TEMP_INDEX" git write-tree)
git archive --format=tar.gz -o deploy.tar.gz "$DEPLOY_TREE"
rm -f "$TEMP_INDEX"

# backend/sender/sender is gitignored (it's a build artifact) so `git archive`
# never contains it, and Server 2 has no `go` toolchain to build it there —
# confirmed 2026-08-09, `which go` finds nothing. The runtime auto-rebuild
# that used to paper over this crash-looped the worker: `git archive` does
# not preserve original file mtimes, so the .go source and any stale binary
# land with near-identical timestamps, and the mtime comparison that decided
# whether to rebuild became a coin flip. Production now refuses to rebuild at
# all (see backend/src/index.ts) — the binary must arrive prebuilt. Cross-
# compiling here, from source at the exact commit being deployed, is
# deterministic and needs no toolchain on the target.
log_info "Cross-compiling sender for linux/amd64 (Server 2 has no Go toolchain)..."
# Resolved to an absolute path BEFORE the subshell's cd: computed as a
# relative path here and passed to `go build -o` after cd'ing into
# backend/sender, it would resolve against the *new* directory instead of
# the one the caller was in — silently building into a path that doesn't
# exist. Confirmed 2026-08-09: exactly that happened, `go build` exited 0
# (go itself has nothing to complain about) and the file was never at the
# path this script went looking for.
SENDER_DIR="$(cd "$(dirname "$0")/backend/sender" && pwd)"
SENDER_BIN="$SENDER_DIR/sender_linux_amd64"
( cd "$SENDER_DIR" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o "$SENDER_BIN" . )
if [ ! -f "$SENDER_BIN" ]; then
	log_error "cross-compile did not produce $SENDER_BIN"
	exit 1
fi
log_info "Built: $(ls -lah "$SENDER_BIN" | awk '{print $5}')"

log_info "==> Step 3: Transfer & Deploy to Server 2"

# Copy deploy package to Server 2 via gateway
log_info "Uploading to Server 2..."
scp -i "$KEY_PATH" \
	-o StrictHostKeyChecking=no \
	-o ProxyCommand="ssh -i $KEY_PATH -W $TARGET_IP:22 $GATEWAY" \
	deploy.tar.gz "$SENDER_BIN" \
	"$TARGET_HOST:~/"
rm -f deploy.tar.gz "$SENDER_BIN"

# Extract, test, and switch on Server 2
log_info "Extracting and deploying on Server 2..."
ssh -i "$KEY_PATH" \
	-o StrictHostKeyChecking=no \
	-o ConnectTimeout=10 \
	-o ProxyCommand="ssh -i $KEY_PATH -W $TARGET_IP:22 $GATEWAY" \
	"$TARGET_HOST" bash -s <<'DEPLOY_LOGIC'
set -euo pipefail
export PATH="$HOME/.bun/bin:/usr/local/go/bin:$PATH"

DEPLOY_TS=$(date +%Y%m%d-%H%M%S)
DEPLOY_ID="${DEPLOY_TS}-deploy"
RELEASE_BASE="/opt/linebot/releases"
CURRENT_LINK="/opt/linebot/current"
SHARED_DB="/opt/linebot/shared/worker.db"
SERVICE_NAME="linebot-worker"

echo "--- Extracting new release ---"
RELEASE_DIR="${RELEASE_BASE}/${DEPLOY_ID}"
mkdir -p "$RELEASE_DIR"
tar -xzf ~/deploy.tar.gz -C "$RELEASE_DIR"
rm -f ~/deploy.tar.gz
chmod -R 755 "$RELEASE_DIR"

echo "--- Installing the cross-compiled sender binary ---"
# Gitignored, so git archive never contains it, and Server 2 has no Go
# toolchain to build one locally — it was cross-compiled on the deploy
# machine and uploaded alongside the archive.
mkdir -p "$RELEASE_DIR/backend/sender"
mv ~/sender_linux_amd64 "$RELEASE_DIR/backend/sender/sender"
chmod +x "$RELEASE_DIR/backend/sender/sender"
ls -lah "$RELEASE_DIR/backend/sender/sender"

echo "--- Verifying production config stays outside the release ---"
# systemd supplies /etc/linebot/worker.env. Releases must be immutable code
# only; the unit also uses --no-env-file as a second guard.
for env_name in .env .env.local .env.production; do
	if [ -e "$RELEASE_DIR/backend/$env_name" ]; then
		echo "--- REFUSING RELEASE: backend/$env_name must not be packaged in production ---"
		exit 1
	fi
done
if [ ! -r /etc/linebot/worker.env ]; then
	echo "--- REFUSING RELEASE: /etc/linebot/worker.env is missing or unreadable ---"
	exit 1
fi

echo "--- Installing backend dependencies ---"
cd "$RELEASE_DIR/backend"
bun install --production

echo "--- Running test suite (automatic .env loading disabled) ---"
TEST_STATUS=0
bun test --no-env-file 2>&1 | tail -40 || TEST_STATUS=$?

if [ "$TEST_STATUS" -ne 0 ]; then
	echo "--- TESTS FAILED (exit $TEST_STATUS) — aborting before the symlink switch ---"
	echo "    $CURRENT_LINK is untouched and still serving; the broken release stays at $RELEASE_DIR for inspection."
	exit 1
fi

rollback_release() {
	echo "--- Rolling back to $ROLLBACK_TARGET ---"
	rm -f "$CURRENT_LINK"
	ln -s "$ROLLBACK_TARGET" "$CURRENT_LINK"
	if ! sudo -n /usr/bin/systemctl restart linebot-worker; then
		echo "--- CRITICAL: release pointer rolled back, but linebot-worker needs manual recovery ---"
	fi
}

ROLLBACK_TARGET=$(cat ~/.rollback_to.txt)
if [ ! -d "$ROLLBACK_TARGET" ]; then
	echo "--- INVALID ROLLBACK TARGET: $ROLLBACK_TARGET is not a release directory ---"
	exit 1
fi

echo "--- Switching symlink: $CURRENT_LINK -> $RELEASE_DIR ---"
rm -f "$CURRENT_LINK"
ln -s "$RELEASE_DIR" "$CURRENT_LINK"

echo "--- Restarting service ---"
if ! sudo -n /usr/bin/systemctl restart linebot-worker; then
	echo "--- RESTART FAILED — rolling back ---"
	rollback_release
	exit 1
fi
sleep 6
STATE=$(sudo -n /usr/bin/systemctl is-active linebot-worker || true)
echo "    is-active: $STATE"
if [ "$STATE" != "active" ]; then
	echo "--- SERVICE DID NOT COME UP — rolling back automatically ---"
	rollback_release
	sleep 6
	echo "    rolled back to $(readlink -f "$CURRENT_LINK"), is-active: $(sudo -n /usr/bin/systemctl is-active linebot-worker || true)"
	exit 1
fi

echo "--- Deploy complete ---"
DEPLOY_LOGIC

log_info "==> Step 4: System Status & Health Checks"

ssh -i "$KEY_PATH" \
	-o StrictHostKeyChecking=no \
	-o ConnectTimeout=10 \
	-o ProxyCommand="ssh -i $KEY_PATH -W $TARGET_IP:22 $GATEWAY" \
	"$TARGET_HOST" bash -s <<'HEALTH_CHECK'
set -euo pipefail

CURRENT_LINK="/opt/linebot/current"
SERVICE_NAME="linebot-worker"

echo "--- Current Release ---"
ls -la "$CURRENT_LINK" 2>&1 | head -1

echo ""
echo "--- Service Status ---"
# No extra flags: sudoers whitelists the exact command "systemctl status
# linebot-worker" for this user — "--no-pager" makes it a different command
# and sudo refuses it ("a password is required"), confirmed 2026-08-09.
sudo -n /usr/bin/systemctl status linebot-worker 2>&1 | head -8 || true

echo ""
echo "--- Process Status ---"
state=$(systemctl is-active linebot-worker.service 2>/dev/null || true)
pid=$(systemctl show -p MainPID --value linebot-worker.service 2>/dev/null || true)
printf '  %-40s state=%s pid=%s
' "linebot-worker.service" "$state" "${pid:-0}"

echo ""
echo "--- Port Listener (8791) ---"
ss -tlnp | grep -E ":8791[[:space:]]" || echo "  (no expected listener)"

echo ""
echo "--- Backend Source Check ---"
ls -la "$CURRENT_LINK/backend/src/dispatch/prewarm-ack.ts" | head -1
ls -la "$CURRENT_LINK/backend/src/bot/bots.ts" | head -1

HEALTH_CHECK

log_info "==> Step 5: API Health Checks (via Server 1 proxy)"

echo ""
echo "Testing API via Server 1 Nginx proxy:"
echo ""

DOMAIN="dakotabot.site"

# Test health endpoint
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${DOMAIN}/api/health" 2>&1 || echo "000")
if [ "$HTTP_CODE" = "401" ]; then
	log_info "API Health: PASS (HTTP $HTTP_CODE — auth required, backend reachable)"
elif [ "$HTTP_CODE" = "200" ]; then
	log_info "API Health: PASS (HTTP $HTTP_CODE)"
else
	log_warn "API Health: Unexpected HTTP $HTTP_CODE"
fi

# Curl verbose check (optional)
log_debug "Full health check response:"
curl -s -I "https://${DOMAIN}/api/health" 2>&1 | head -5 || true

echo ""
log_info "=== Server 2 Deploy & Restart Complete ==="
echo ""
echo "Rollback command (if needed):"
echo "  On Server 2: restore /opt/linebot/current to the path in ~/.rollback_to.txt,"
echo "  then restart linebot-worker."
echo ""
