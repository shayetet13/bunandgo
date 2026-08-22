#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
KEY_PATH="${KEY_PATH:-/c/Users/Administrator/.ssh/id_ed25519}"
TARGET="${TARGET:-root@172.105.237.118}"
RELEASE_BASE="/opt/linebot-relay/releases"
CURRENT_LINK="/opt/linebot-relay/current"
SERVICE="linebot-lane-relay.service"

if ! git -C "$ROOT_DIR" diff --quiet || ! git -C "$ROOT_DIR" diff --cached --quiet; then
	echo "Refusing Server 3 deploy: commit the working tree first." >&2
	exit 1
fi

SHA="$(git -C "$ROOT_DIR" rev-parse --short HEAD)"
RELEASE_ID="$(date -u +%Y%m%d-%H%M%S)-${SHA}"
REMOTE_RELEASE="$RELEASE_BASE/$RELEASE_ID"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf -- "$BUILD_DIR"' EXIT

(
	cd "$ROOT_DIR/backend"
	bun build src/relay/index.ts --target=bun --minify --outfile="$BUILD_DIR/relay.js"
)

if grep -aEq 'session-manager|client/login|auth/session|sqlite\.ts|worker\.db|app\.db' "$BUILD_DIR/relay.js"; then
	echo "Refusing Server 3 deploy: relay bundle contains a forbidden bot/login/database dependency." >&2
	exit 1
fi

PREVIOUS="$(ssh -i "$KEY_PATH" -o BatchMode=yes "$TARGET" "readlink -f '$CURRENT_LINK' 2>/dev/null || true")"
ssh -i "$KEY_PATH" -o BatchMode=yes "$TARGET" "install -d -o linebot-relay -g linebot-relay '$REMOTE_RELEASE'"
scp -i "$KEY_PATH" -q "$BUILD_DIR/relay.js" "$TARGET:$REMOTE_RELEASE/relay.js"
scp -i "$KEY_PATH" -q "$ROOT_DIR/deploy/server3/linebot-lane-relay.service" "$TARGET:/etc/systemd/system/$SERVICE"
ssh -i "$KEY_PATH" -o BatchMode=yes "$TARGET" "
	set -eu
	chown linebot-relay:linebot-relay '$REMOTE_RELEASE/relay.js'
	chmod 0550 '$REMOTE_RELEASE/relay.js'
	ln -sfn '$REMOTE_RELEASE' '$CURRENT_LINK'
	systemctl daemon-reload
	if ! systemctl restart '$SERVICE'; then
		${PREVIOUS:+ln -sfn '$PREVIOUS' '$CURRENT_LINK'; systemctl restart '$SERVICE';}
		exit 1
	fi
	for attempt in \$(seq 1 40); do
		if curl -fsS http://10.90.0.2:8795/healthz >/tmp/linebot-relay-health.json; then
			python3 -c 'import json; d=json.load(open(\"/tmp/linebot-relay-health.json\")); assert d[\"healthy\"] and all(x[\"ready\"] == x[\"total\"] for x in d[\"origins\"])'
			exit 0
		fi
		sleep 0.5
	done
	${PREVIOUS:+ln -sfn '$PREVIOUS' '$CURRENT_LINK'; systemctl restart '$SERVICE';}
	exit 1
"

echo "Server 3 deployed $RELEASE_ID with lane-only bundle."
