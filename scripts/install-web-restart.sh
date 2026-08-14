#!/usr/bin/env bash
# One-time Server 2 installation for the admin-only dashboard restart button.
# Run as root from the current release: sudo bash scripts/install-web-restart.sh

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "$0")/../deploy/server2" && pwd)"
TRIGGER_DIR=/opt/linebot/shared
PATH_UNIT=linebot-worker-restart.path
SERVICE_UNIT=linebot-worker-restart.service

[ "$(id -u)" -eq 0 ] || { echo "run as root: sudo bash scripts/install-web-restart.sh" >&2; exit 1; }
[ -f "$SOURCE_DIR/$PATH_UNIT" ]
[ -f "$SOURCE_DIR/$SERVICE_UNIT" ]

[ -d "$TRIGGER_DIR" ] || { echo "$TRIGGER_DIR does not exist" >&2; exit 1; }
runuser -u linebot -- test -w "$TRIGGER_DIR" || { echo "$TRIGGER_DIR is not writable by linebot" >&2; exit 1; }
install -o root -g root -m 644 "$SOURCE_DIR/$PATH_UNIT" "/etc/systemd/system/$PATH_UNIT"
install -o root -g root -m 644 "$SOURCE_DIR/$SERVICE_UNIT" "/etc/systemd/system/$SERVICE_UNIT"

systemctl daemon-reload
systemctl enable --now "$PATH_UNIT"
systemctl is-active --quiet "$PATH_UNIT"

echo "$PATH_UNIT is active; the dashboard may now restart linebot-worker.service"
