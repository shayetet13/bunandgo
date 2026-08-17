#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")" && pwd)
TARGET=${LANE_NODE_TARGET:-root@104.105.144.89}
KEY_PATH=${LANE_NODE_SSH_KEY:-/c/Users/Administrator/.ssh/linebot_newserver_ed25519}
DEPLOY_ID=$(date +%Y%m%d-%H%M%S)-lane-node
BUILD_DIR=$(mktemp -d)
trap 'rm -rf "$BUILD_DIR"' EXIT

cd "$ROOT_DIR/backend"
bun test src/dispatch/binary-protocol.test.ts src/dispatch/lane-node-server.test.ts src/dispatch/remote-lanes.test.ts src/dispatch/h2-lanes.test.ts
bun run typecheck
bun build src/lane-node.ts --target=bun --minify --outfile "$BUILD_DIR/lane-node.js"

scp -i "$KEY_PATH" -o StrictHostKeyChecking=no \
	"$BUILD_DIR/lane-node.js" "$TARGET:/tmp/$DEPLOY_ID.js"
scp -i "$KEY_PATH" -o StrictHostKeyChecking=no \
	"$ROOT_DIR/deploy/lane-node/linebot-lane-node.service" "$TARGET:/tmp/linebot-lane-node.service"

ssh -i "$KEY_PATH" -o StrictHostKeyChecking=no "$TARGET" bash -s -- "$DEPLOY_ID" <<'REMOTE'
set -euo pipefail
deploy_id=$1
release=/opt/linebot-lane/releases/$deploy_id
previous=$(readlink -f /opt/linebot-lane/current 2>/dev/null || true)

id linebot-lane >/dev/null 2>&1 || useradd --system --home /opt/linebot-lane --shell /usr/sbin/nologin linebot-lane
install -d -o linebot-lane -g linebot-lane -m 0750 /opt/linebot-lane/releases
install -d -o root -g linebot-lane -m 0750 /etc/linebot-lane
install -d -o linebot-lane -g linebot-lane -m 0750 "$release"
install -o linebot-lane -g linebot-lane -m 0550 "/tmp/$deploy_id.js" "$release/lane-node.js"
install -o root -g root -m 0644 /tmp/linebot-lane-node.service /etc/systemd/system/linebot-lane-node.service
rm -f "/tmp/$deploy_id.js" /tmp/linebot-lane-node.service

if [ ! -x /usr/local/bin/bun ]; then
	curl -fsSL https://bun.sh/install | bash
	install -o root -g root -m 0755 /root/.bun/bin/bun /usr/local/bin/bun
fi
if [ ! -f /etc/linebot-lane/lane-node.env ]; then
	echo "missing /etc/linebot-lane/lane-node.env; provision WireGuard and the secret first" >&2
	exit 1
fi

ln -sfn "$release" /opt/linebot-lane/current
systemctl daemon-reload
systemctl enable linebot-lane-node.service >/dev/null
if ! systemctl restart linebot-lane-node.service; then
	[ -z "$previous" ] || ln -sfn "$previous" /opt/linebot-lane/current
	exit 1
fi
sleep 2
if ! curl -fsS --max-time 3 http://127.0.0.1:4891/healthz >/dev/null; then
	[ -z "$previous" ] || ln -sfn "$previous" /opt/linebot-lane/current
	[ -z "$previous" ] || systemctl restart linebot-lane-node.service
	exit 1
fi
echo "deployed=$release"
systemctl is-active linebot-lane-node.service
REMOTE
