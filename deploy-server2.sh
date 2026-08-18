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
	setup-shard-b.sh \
	backend/src/api/worker-events.ts \
	backend/src/api/worker-events.test.ts \
	backend/src/api/worker-proxy.ts \
	backend/src/api/worker-proxy.test.ts \
	backend/src/api/routes/system.ts \
	backend/src/api/routes/system.test.ts \
	backend/src/bot/start-confirmation.test.ts \
	backend/src/bot/worker-topology.ts \
	backend/src/bot/worker-topology.test.ts \
	frontend/src/lib/rule-input.ts \
	frontend/src/lib/rule-input.test.ts \
	frontend/src/lib/race-commentary.ts \
	frontend/src/lib/race-commentary.test.ts
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
# systemd supplies /etc/linebot/worker*.env per process. Copying the primary
# env into this shared working directory lets Bun auto-load its EXCLUDE value
# in shard B as well, producing an include+exclude conflict. Releases must be
# immutable code only; the units also use --no-env-file as a second guard.
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

read_env_value() {
	local file="$1" key="$2" count
	count=$(grep -c "^${key}=" "$file" 2>/dev/null || true)
	if [ "$count" -gt 1 ]; then
		echo "--- INVALID ENV: $file contains $count copies of $key ---" >&2
		return 1
	fi
	grep "^${key}=" "$file" 2>/dev/null | tail -1 | cut -d= -f2- || true
}

normalize_owner_csv() {
	local raw="$1"
	[ -z "$raw" ] && return 0
	if ! printf '%s' "$raw" | grep -Eq '^[1-9][0-9]*(,[1-9][0-9]*)*$'; then
		echo "--- INVALID OWNER SCOPE: '$raw' must be comma-separated positive integer ids ---" >&2
		return 1
	fi
	printf '%s' "$raw" | tr ',' '\n' | awk '$1 > 0' | sort -n -u | paste -sd, -
}

normalize_owner_routes() {
	local raw="$1"
	[ -z "$raw" ] && return 0
	if ! printf '%s' "$raw" | grep -Eq '^([1-9][0-9]*=http://127\.0\.0\.1:[1-9][0-9]*)(,[1-9][0-9]*=http://127\.0\.0\.1:[1-9][0-9]*)*$'; then
		echo "--- INVALID OWNER ROUTES: use ownerId=http://127.0.0.1:port entries ---" >&2
		return 1
	fi
	printf '%s' "$raw" | tr ',' '\n' | awk -F= '{ print $1 "\t" $0 }' | sort -n -k1,1 | cut -f2- | paste -sd, -
}

RUNTIME_TOPOLOGY=/opt/linebot/shared/worker-topology.json
RUNTIME_TOPOLOGY_ACTIVE=0
if [ -r "$RUNTIME_TOPOLOGY" ]; then
	RUNTIME_TOPOLOGY_ACTIVE=1
	echo "--- Validating atomic shared worker topology before restart ---"
	# Validate through the exact production parser that will run before any
	# sender or LINE session starts. Both known service ports must resolve to
	# opposite, authenticated sides of the same split.
	NODE_ENV=production DB_PATH="$SHARED_DB" PORT=8791 bun --no-env-file -e '
		import { validateWorkerTopology } from "./src/bot/worker-topology.ts";
		const topology = validateWorkerTopology();
		if (topology.ownerRoutes.size === 0 || topology.controlPlaneUrl) throw new Error("8791 is not the control plane");
	'
	NODE_ENV=production DB_PATH="$SHARED_DB" PORT=8792 bun --no-env-file -e '
		import { validateWorkerTopology } from "./src/bot/worker-topology.ts";
		const topology = validateWorkerTopology();
		if (!topology.controlPlaneUrl || topology.ownerRoutes.size !== 0) throw new Error("8792 is not a shard");
	'
	if ! systemctl is-enabled linebot-worker-shard-b.service >/dev/null 2>&1 \
		&& ! systemctl is-active linebot-worker-shard-b.service >/dev/null 2>&1; then
		echo "--- INVALID RUNTIME TOPOLOGY: shard B is configured but its service is neither enabled nor active ---"
		exit 1
	fi
	ENABLED_SHARD_UNITS=" linebot-worker-shard-b"
else
echo "--- Validating disjoint worker scopes before restart ---"
PRIMARY_INCLUDE=$(read_env_value /etc/linebot/worker.env WORKER_OWNER_SCOPE)
PRIMARY_EXCLUDE=$(read_env_value /etc/linebot/worker.env WORKER_OWNER_EXCLUDE)
PRIMARY_ROUTES=$(read_env_value /etc/linebot/worker.env WORKER_OWNER_ROUTES)
PRIMARY_CONTROL_URL=$(read_env_value /etc/linebot/worker.env CONTROL_PLANE_URL)
PRIMARY_TOKEN=$(read_env_value /etc/linebot/worker.env CONTROL_PLANE_TOKEN)
PRIMARY_PORT=$(read_env_value /etc/linebot/worker.env PORT)
PRIMARY_FAST_INTERVAL=$(read_env_value /etc/linebot/worker.env SQUARE_FAST_POLL_INTERVAL_MS)
PRIMARY_FAST_GATE=$(read_env_value /etc/linebot/worker.env SQUARE_FAST_POLL_ALLOW_50MS)
PRIMARY_ZERO_GATE=$(read_env_value /etc/linebot/worker.env SQUARE_FAST_POLL_ALLOW_ZERO_MS)
if [ -n "$PRIMARY_INCLUDE" ]; then
	echo "--- INVALID PRIMARY ENV: WORKER_OWNER_SCOPE belongs only in shard env files ---"
	exit 1
fi
if [ -n "$PRIMARY_CONTROL_URL" ]; then
	echo "--- INVALID PRIMARY ENV: CONTROL_PLANE_URL belongs only in shard env files ---"
	exit 1
fi
if ! printf '%s' "$PRIMARY_PORT" | grep -Eq '^[1-9][0-9]*$'; then
	echo "--- INVALID PRIMARY ENV: PORT must be a positive integer ---"
	exit 1
fi
if { [ "$PRIMARY_FAST_INTERVAL" = "50" ] && [ "$PRIMARY_FAST_GATE" = "1" ]; } \
	|| [ "$PRIMARY_ZERO_GATE" = "1" ]; then
	echo "--- UNSAFE PRIMARY ENV: sub-100ms fast-poll is reserved for an isolated shard ---"
	exit 1
fi
PRIMARY_EXCLUDE=$(normalize_owner_csv "$PRIMARY_EXCLUDE")
PRIMARY_ROUTES=$(normalize_owner_routes "$PRIMARY_ROUTES")

SHARD_UNITS=$(systemctl list-unit-files 'linebot-worker-shard-*.service' --no-legend 2>/dev/null | awk '{print $1}' || true)
ENABLED_SHARD_UNITS=""
ALL_SHARD_OWNERS=""
EXPECTED_OWNER_ROUTES=""
for unit in $SHARD_UNITS; do
	unit_command=${unit%.service}
	# Querying enablement/activity is read-only and does not need sudo. Treat a
	# manually-started but disabled shard as part of the live topology too.
	if ! systemctl is-enabled "$unit" >/dev/null 2>&1 \
		&& ! systemctl is-active "$unit" >/dev/null 2>&1; then
		continue
	fi
	shard_name=${unit#linebot-worker-}
	shard_name=${shard_name%.service}
	env_file="/etc/linebot/worker-${shard_name}.env"
	gate_file="/etc/linebot/worker-${shard_name}-enabled"
	if [ ! -r "$env_file" ] || [ ! -e "$gate_file" ]; then
		echo "--- INVALID SHARD: $unit is enabled/active but $env_file or $gate_file is missing ---"
		exit 1
	fi
	shard_scope=$(read_env_value "$env_file" WORKER_OWNER_SCOPE)
	shard_exclude=$(read_env_value "$env_file" WORKER_OWNER_EXCLUDE)
	shard_routes=$(read_env_value "$env_file" WORKER_OWNER_ROUTES)
	shard_control_url=$(read_env_value "$env_file" CONTROL_PLANE_URL)
	shard_token=$(read_env_value "$env_file" CONTROL_PLANE_TOKEN)
	shard_port=$(read_env_value "$env_file" PORT)
	shard_fast_interval=$(read_env_value "$env_file" SQUARE_FAST_POLL_INTERVAL_MS)
	shard_fast_gate=$(read_env_value "$env_file" SQUARE_FAST_POLL_ALLOW_50MS)
	shard_zero_gate=$(read_env_value "$env_file" SQUARE_FAST_POLL_ALLOW_ZERO_MS)
	if [ -z "$shard_scope" ] || [ -n "$shard_exclude" ] || [ -n "$shard_routes" ]; then
		echo "--- INVALID SHARD ENV: $env_file needs SCOPE and must not have EXCLUDE or ROUTES ---"
		exit 1
	fi
	if ! printf '%s' "$shard_port" | grep -Eq '^[1-9][0-9]*$' || [ "$shard_port" = "$PRIMARY_PORT" ]; then
		echo "--- INVALID SHARD ENV: $env_file needs a distinct positive PORT ---"
		exit 1
	fi
	if [ "$shard_control_url" != "http://127.0.0.1:${PRIMARY_PORT}" ]; then
		echo "--- INVALID SHARD ENV: CONTROL_PLANE_URL must target the primary loopback port ---"
		exit 1
	fi
	if [ "${#PRIMARY_TOKEN}" -lt 32 ] || [ "$shard_token" != "$PRIMARY_TOKEN" ]; then
		echo "--- INVALID CONTROL TOKEN: primary and shard need the same 32+ character token ---"
		exit 1
	fi
	if [ "$shard_fast_interval" = "50" ] && [ "$shard_fast_gate" != "1" ]; then
		echo "--- INVALID FAST-POLL CONFIG: $env_file requests 50ms without ALLOW_50MS=1 ---"
		exit 1
	fi
	if { [ "$shard_fast_interval" = "0" ] && [ "$shard_zero_gate" != "1" ]; } \
		|| { [ "$shard_zero_gate" = "1" ] && [ "$shard_fast_interval" != "0" ]; }; then
		echo "--- INVALID FAST-POLL CONFIG: $env_file zero-delay requires INTERVAL_MS=0 and ALLOW_ZERO_MS=1 ---"
		exit 1
	fi
	shard_scope=$(normalize_owner_csv "$shard_scope")
	# Sudoers deliberately whitelists the suffix-free spelling used here.
	ENABLED_SHARD_UNITS="$ENABLED_SHARD_UNITS $unit_command"
	ALL_SHARD_OWNERS="${ALL_SHARD_OWNERS}${ALL_SHARD_OWNERS:+,}${shard_scope}"
	for owner_id in $(printf '%s' "$shard_scope" | tr ',' ' '); do
		EXPECTED_OWNER_ROUTES="${EXPECTED_OWNER_ROUTES}${EXPECTED_OWNER_ROUTES:+,}${owner_id}=http://127.0.0.1:${shard_port}"
	done
done

NORMALIZED_SHARD_OWNERS=$(normalize_owner_csv "$ALL_SHARD_OWNERS")
SHARD_OWNER_COUNT=$(printf '%s' "$ALL_SHARD_OWNERS" | tr ',' '\n' | sed '/^$/d' | wc -l | tr -d ' ')
UNIQUE_SHARD_OWNER_COUNT=$(printf '%s' "$NORMALIZED_SHARD_OWNERS" | tr ',' '\n' | sed '/^$/d' | wc -l | tr -d ' ')
NORMALIZED_EXPECTED_ROUTES=$(normalize_owner_routes "$EXPECTED_OWNER_ROUTES")
ROUTE_OWNER_COUNT=$(printf '%s' "$PRIMARY_ROUTES" | tr ',' '\n' | sed '/^$/d' | wc -l | tr -d ' ')
UNIQUE_ROUTE_OWNER_COUNT=$(printf '%s' "$PRIMARY_ROUTES" | tr ',' '\n' | cut -d= -f1 | sort -n -u | sed '/^$/d' | wc -l | tr -d ' ')
if [ "$SHARD_OWNER_COUNT" != "$UNIQUE_SHARD_OWNER_COUNT" ]; then
	echo "--- INVALID SHARDS: at least one owner is assigned to more than one shard ---"
	exit 1
fi
if [ "$PRIMARY_EXCLUDE" != "$NORMALIZED_SHARD_OWNERS" ]; then
	echo "--- INVALID SPLIT: primary EXCLUDE='$PRIMARY_EXCLUDE', enabled shard owners='$NORMALIZED_SHARD_OWNERS' ---"
	exit 1
fi
if [ "$ROUTE_OWNER_COUNT" != "$UNIQUE_ROUTE_OWNER_COUNT" ] || [ "$PRIMARY_ROUTES" != "$NORMALIZED_EXPECTED_ROUTES" ]; then
	echo "--- INVALID ROUTES: primary WORKER_OWNER_ROUTES must map every excluded owner to its enabled shard ---"
	exit 1
fi
fi

rollback_release() {
	echo "--- Rolling every worker back to $ROLLBACK_TARGET ---"
	rm -f "$CURRENT_LINK"
	ln -s "$ROLLBACK_TARGET" "$CURRENT_LINK"
	local rollback_failed=0
	if ! sudo -n /usr/bin/systemctl restart linebot-worker; then rollback_failed=1; fi
	for rollback_unit in $ENABLED_SHARD_UNITS; do
		if ! sudo -n /usr/bin/systemctl restart "$rollback_unit"; then rollback_failed=1; fi
	done
	if [ "$rollback_failed" -ne 0 ]; then
		echo "--- CRITICAL: release pointer rolled back, but one or more services need manual recovery ---"
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

if [ "$RUNTIME_TOPOLOGY_ACTIVE" -eq 1 ]; then
	echo "--- Restarting primary and shard together for an atomic owner handoff ---"
	# The legacy topology has a catch-all primary beside a scoped shard. Starting
	# either new role several seconds before the other creates a duplicate LINE
	# login window. Dispatch both restarts concurrently, then verify both before
	# continuing; the new runtime file makes their scopes disjoint at boot.
	primary_status=0
	shard_status=0
	sudo -n /usr/bin/systemctl restart linebot-worker || primary_status=$? &
	primary_restart_pid=$!
	sudo -n /usr/bin/systemctl restart linebot-worker-shard-b || shard_status=$? &
	shard_restart_pid=$!
	wait "$primary_restart_pid" || primary_status=$?
	wait "$shard_restart_pid" || shard_status=$?
	if [ "$primary_status" -ne 0 ] || [ "$shard_status" -ne 0 ]; then
		echo "--- ATOMIC WORKER RESTART FAILED (primary=$primary_status shard=$shard_status) ---"
		exit 1
	fi
	sleep 8
	PRIMARY_STATE=$(sudo -n /usr/bin/systemctl is-active linebot-worker || true)
	SHARD_STATE=$(sudo -n /usr/bin/systemctl is-active linebot-worker-shard-b || true)
	echo "    linebot-worker: $PRIMARY_STATE"
	echo "    linebot-worker-shard-b: $SHARD_STATE"
	if [ "$PRIMARY_STATE" != "active" ] || [ "$SHARD_STATE" != "active" ]; then
		echo "--- ONE OR MORE WORKERS DID NOT COME UP ---"
		exit 1
	fi
	for expected_port in 8791 8792; do
		if ! ss -H -ltn | awk -v suffix=":$expected_port" '$4 ~ suffix "$" { found=1 } END { exit !found }'; then
			echo "--- WORKER PROCESS IS ACTIVE BUT PORT $expected_port IS NOT LISTENING ---"
			exit 1
		fi
	done
else
echo "--- Restarting service ---"
if ! sudo -n /usr/bin/systemctl restart linebot-worker; then
	echo "--- PRIMARY RESTART FAILED — rolling every worker back ---"
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

echo "--- Checking for additional shard processes (one per extra CPU core) ---"
# Discovers every linebot-worker-shard-*.service unit installed on this
# host, however many there are — adding shard-c, shard-d, etc. later (e.g.
# after moving to a bigger VM) needs no change here, just another unit file
# following linebot-worker-shard-b.service's pattern, its own sudoers entry,
# and its own WORKER_OWNER_SCOPE. The release pointer is shared, so this is a
# transactional restart: one shard failure rolls every worker back to the
# saved release instead of leaving two code versions operating one database.
if [ -z "$ENABLED_SHARD_UNITS" ]; then
	echo "    no enabled or active shard units on this host, skipping"
else
	for unit in $ENABLED_SHARD_UNITS; do
		echo "--- Restarting $unit ---"
		if sudo -n /usr/bin/systemctl restart "$unit" 2>"/tmp/${unit}.restart.err"; then
			sleep 6
			SHARD_STATE=$(sudo -n /usr/bin/systemctl is-active "$unit" 2>/dev/null || true)
			echo "    $unit is-active: $SHARD_STATE"
			if [ "$SHARD_STATE" != "active" ]; then
				echo "--- $unit did not come up — rolling every worker back ---"
				rollback_release
				exit 1
			fi
		else
			# Most likely cause: sudoers hasn't been extended to this unit's
			# exact restart/is-active/status commands yet — the linebot user's
			# sudo access is scoped to literal command strings, one per unit,
			# not a wildcard (see deploy/server2/README.md).
			echo "--- sudo refused to restart $unit — rolling every worker back ---"
			cat "/tmp/${unit}.restart.err" 2>/dev/null || true
			rollback_release
			exit 1
		fi
	done
fi
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
for unit in linebot-worker.service $(systemctl list-unit-files 'linebot-worker-shard-*.service' --no-legend 2>/dev/null | awk '{print $1}'); do
	state=$(systemctl is-active "$unit" 2>/dev/null || true)
	pid=$(systemctl show -p MainPID --value "$unit" 2>/dev/null || true)
	printf '  %-40s state=%s pid=%s\n' "$unit" "$state" "${pid:-0}"
done

echo ""
echo "--- Port Listeners (8791 control plane, 8792 shard B) ---"
ss -tlnp | grep -E ':(8791|8792)[[:space:]]' || echo "  (no expected listener)"

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
echo "  then restart linebot-worker and every enabled linebot-worker-shard-* unit."
echo ""
