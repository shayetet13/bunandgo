#!/usr/bin/env bash
# Atomic owner-scope cutover for the second Bun process on Server 2.
#
# Usage:
#   sudo ./setup-shard-b.sh [owner_user_id[,owner_user_id...]]
#   sudo ./setup-shard-b.sh --rollback /var/backups/linebot-shard-b/<timestamp>
#
# The default moves owner 2 (all of that owner's current and future bots,
# including bot 117 "Big sa"). Splitting by individual bot is intentionally
# unsupported because sibling coordination is process-local.

set -Eeuo pipefail
umask 077

PRIMARY_UNIT="linebot-worker.service"
SHARD_UNIT="linebot-worker-shard-b.service"
PRIMARY_ENV="/etc/linebot/worker.env"
SHARD_ENV="/etc/linebot/worker-shard-b.env"
PRIMARY_UNIT_FILE="/etc/systemd/system/$PRIMARY_UNIT"
SHARD_UNIT_FILE="/etc/systemd/system/$SHARD_UNIT"
SUDOERS_FILE="/etc/sudoers.d/linebot-worker-shard-b"
SHARD_GATE="/etc/linebot/worker-shard-b-enabled"
CURRENT_RELEASE="/opt/linebot/current"
DB_PATH="/opt/linebot/shared/worker.db"
BACKUP_ROOT="/var/backups/linebot-shard-b"
BUN="/usr/local/bin/bun"

die() {
	echo "ERROR: $*" >&2
	exit 1
}

if [ "$(id -u)" -ne 0 ]; then
	die "run this with sudo"
fi

for command_name in systemctl install sed grep awk sort paste ss visudo tr cut wc readlink mktemp seq cp rm chmod chown mkdir date sleep touch; do
	command -v "$command_name" >/dev/null 2>&1 || die "required command not found: $command_name"
done
[ -x "$BUN" ] || die "Bun not found at $BUN"

backup_optional() {
	local source="$1" name="$2"
	if [ -e "$source" ] || [ -L "$source" ]; then
		cp -a -- "$source" "$BACKUP_DIR/$name"
	else
		: > "$BACKUP_DIR/$name.absent"
	fi
}

restore_optional() {
	local target="$1" name="$2"
	if [ -e "$BACKUP_DIR/$name" ] || [ -L "$BACKUP_DIR/$name" ]; then
		rm -f -- "$target"
		cp -a -- "$BACKUP_DIR/$name" "$target"
	elif [ -e "$BACKUP_DIR/$name.absent" ]; then
		rm -f -- "$target"
	else
		die "backup is incomplete: missing $name"
	fi
}

capture_running_bot_ids() {
	local output="$1"
	LINEBOT_DB_PATH="$DB_PATH" "$BUN" --no-env-file -e '
		import { Database } from "bun:sqlite";
		const db = new Database(process.env.LINEBOT_DB_PATH!, { readonly: true });
		const rows = db.query("SELECT id FROM bots WHERE status != '\''offline'\'' ORDER BY id").all() as Array<{id:number}>;
		console.log(rows.map((row) => row.id).join(","));
		db.close();
	' > "$output"
}

capture_moved_running_bot_ids() {
	local output="$1" owner_scope="$2"
	LINEBOT_DB_PATH="$DB_PATH" LINEBOT_OWNER_SCOPE="$owner_scope" "$BUN" --no-env-file -e '
		import { Database } from "bun:sqlite";
		const owners = (process.env.LINEBOT_OWNER_SCOPE ?? "").split(",").map(Number);
		const db = new Database(process.env.LINEBOT_DB_PATH!, { readonly: true });
		const rows = db.query("SELECT id, owner_user_id, status FROM bots ORDER BY id").all() as Array<{id:number;owner_user_id:number|null;status:string}>;
		const owned = rows.filter((row) => row.owner_user_id !== null && owners.includes(row.owner_user_id));
		const missingOwners = owners.filter((owner) => !owned.some((row) => row.owner_user_id === owner));
		if (missingOwners.length) throw new Error(`owner ids have no bots: ${missingOwners.join(",")}`);
		console.log(owned.filter((row) => row.status !== "offline").map((row) => row.id).join(","));
		db.close();
	' > "$output"
}

mark_bot_ids_for_resume() {
	local input="$1"
	[ -s "$input" ] || return 0
	LINEBOT_DB_PATH="$DB_PATH" LINEBOT_BOT_IDS="$(cat "$input")" "$BUN" --no-env-file -e '
		import { Database } from "bun:sqlite";
		const ids = (process.env.LINEBOT_BOT_IDS ?? "").split(",").filter(Boolean).map(Number).filter(Number.isInteger);
		const db = new Database(process.env.LINEBOT_DB_PATH!, { create: true });
		db.exec("PRAGMA busy_timeout = 5000");
		const update = db.prepare("UPDATE bots SET status = '\''online'\'' WHERE id = ?");
		db.transaction((botIds: number[]) => { for (const id of botIds) update.run(id); })(ids);
		db.close();
	'
}

restore_service_state() {
	local unit="$1" state_file="$2"
	if [ "$(cat "$state_file")" = "active" ]; then
		systemctl start "$unit"
	fi
	return 0
}

env_single_value() {
	local file="$1" key="$2" count
	[ -r "$file" ] || return 1
	count=$(grep -c "^${key}=" "$file" 2>/dev/null || true)
	[ "$count" -le 1 ] || return 1
	grep "^${key}=" "$file" 2>/dev/null | tail -1 | cut -d= -f2- || true
}

owner_csv_is_valid() {
	printf '%s' "$1" | grep -Eq '^[1-9][0-9]*(,[1-9][0-9]*)*$'
}

# A rollback may restore the exact configuration that caused the incident:
# an active scoped shard beside a catch-all primary that never excluded it.
# Refuse to boot both in that state. Superset exclusion is sufficient for
# duplicate-session safety; stricter current topology validation happens on a
# normal deploy/cutover.
restored_shard_is_disjoint() {
	local primary_scope primary_exclude shard_scope shard_exclude owner_id
	primary_scope=$(env_single_value "$PRIMARY_ENV" WORKER_OWNER_SCOPE) || return 1
	primary_exclude=$(env_single_value "$PRIMARY_ENV" WORKER_OWNER_EXCLUDE) || return 1
	shard_scope=$(env_single_value "$SHARD_ENV" WORKER_OWNER_SCOPE) || return 1
	shard_exclude=$(env_single_value "$SHARD_ENV" WORKER_OWNER_EXCLUDE) || return 1
	[ -z "$primary_scope" ] || return 1
	[ -z "$shard_exclude" ] || return 1
	owner_csv_is_valid "$primary_exclude" || return 1
	owner_csv_is_valid "$shard_scope" || return 1
	for owner_id in $(printf '%s' "$shard_scope" | tr ',' ' '); do
		case ",$primary_exclude," in
			*",$owner_id,"*) ;;
			*) return 1 ;;
		esac
	done
	return 0
}

restore_from_backup() {
	local mode="$1" resume_ids="$BACKUP_DIR/running-bot-ids"
	local current_ids=""

	if [ "$mode" = "manual" ]; then
		current_ids=$(mktemp /tmp/linebot-rollback-running.XXXXXX)
		capture_running_bot_ids "$current_ids"
		resume_ids="$current_ids"
	fi

	echo "=== Restoring pre-cutover configuration from $BACKUP_DIR ==="
	systemctl stop "$SHARD_UNIT" "$PRIMARY_UNIT" 2>/dev/null || true
	systemctl disable "$SHARD_UNIT" >/dev/null 2>&1 || true

	restore_optional "$PRIMARY_ENV" primary.env
	restore_optional "$SHARD_ENV" shard.env
	restore_optional "$PRIMARY_UNIT_FILE" primary.service
	restore_optional "$SHARD_UNIT_FILE" shard.service
	restore_optional "$SUDOERS_FILE" shard.sudoers
	restore_optional "$SHARD_GATE" shard.gate

	visudo -c >/dev/null
	systemctl daemon-reload
	mark_bot_ids_for_resume "$resume_ids"

	local shard_may_start=0
	if [ -e "$SHARD_UNIT_FILE" ] && restored_shard_is_disjoint; then
		shard_may_start=1
		if [ "$(cat "$BACKUP_DIR/shard.enabled")" = "enabled" ]; then
			systemctl enable "$SHARD_UNIT" >/dev/null
		fi
	else
		systemctl disable "$SHARD_UNIT" >/dev/null 2>&1 || true
		if [ "$(cat "$BACKUP_DIR/shard.active")" = "active" ] || [ "$(cat "$BACKUP_DIR/shard.enabled")" = "enabled" ]; then
			echo "WARNING: backup would restore overlapping/invalid owner scopes." >&2
			echo "         Shard B remains stopped and disabled; primary is the only worker started." >&2
		fi
	fi

	# Bring the control plane up before any shard can resume and emit events.
	# If an unsafe active shard was suppressed, start the primary even if the
	# saved primary state was not active so the catch-all service carries bots.
	if [ "$(cat "$BACKUP_DIR/primary.active")" = "active" ] \
		|| { [ "$shard_may_start" -eq 0 ] && [ "$(cat "$BACKUP_DIR/shard.active")" = "active" ]; }; then
		systemctl start "$PRIMARY_UNIT"
	fi
	if [ "$shard_may_start" -eq 1 ]; then
		restore_service_state "$SHARD_UNIT" "$BACKUP_DIR/shard.active"
	fi

	[ -n "$current_ids" ] && rm -f -- "$current_ids"
	echo "Rollback complete. Verify both service status and bot online state."
}

if [ "${1:-}" = "--rollback" ]; then
	[ "$#" -eq 2 ] || die "usage: $0 --rollback $BACKUP_ROOT/<timestamp>"
	BACKUP_DIR=$(readlink -f -- "$2")
	case "$BACKUP_DIR" in
		"$BACKUP_ROOT"/*) ;;
		*) die "refusing backup path outside $BACKUP_ROOT" ;;
	esac
	[ -f "$BACKUP_DIR/backup.complete" ] || die "not a complete shard backup: $BACKUP_DIR"
	restore_from_backup manual
	exit 0
fi

[ "$#" -le 1 ] || die "usage: $0 [owner_user_id[,owner_user_id...]]"
OWNER_SCOPE="${1:-${WORKER_OWNER_SCOPE:-2}}"
if ! printf '%s' "$OWNER_SCOPE" | grep -Eq '^[1-9][0-9]*(,[1-9][0-9]*)*$'; then
	die "owner scope must be comma-separated positive integer ids"
fi
NORMALIZED_SCOPE=$(printf '%s' "$OWNER_SCOPE" | tr ',' '\n' | sort -n -u | paste -sd, -)
[ "$NORMALIZED_SCOPE" = "$OWNER_SCOPE" ] || die "owner scope must be sorted and contain no duplicates (use $NORMALIZED_SCOPE)"

[ -r "$PRIMARY_ENV" ] || die "$PRIMARY_ENV is required and must be readable"
[ -r "$DB_PATH" ] || die "$DB_PATH is required and must be readable"
[ -f "$CURRENT_RELEASE/deploy/server2/linebot-worker.service" ] || die "current release is missing the primary unit asset"
[ -f "$CURRENT_RELEASE/deploy/server2/linebot-worker-shard-b.service" ] || die "current release is missing the shard unit asset"
[ "$(systemctl is-active "$PRIMARY_UNIT" 2>/dev/null || true)" = "active" ] || die "$PRIMARY_UNIT must be active before cutover"

mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"
BACKUP_DIR="$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)"
mkdir "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

backup_optional "$PRIMARY_ENV" primary.env
backup_optional "$SHARD_ENV" shard.env
backup_optional "$PRIMARY_UNIT_FILE" primary.service
backup_optional "$SHARD_UNIT_FILE" shard.service
backup_optional "$SUDOERS_FILE" shard.sudoers
backup_optional "$SHARD_GATE" shard.gate
systemctl is-active "$PRIMARY_UNIT" > "$BACKUP_DIR/primary.active" 2>/dev/null || true
systemctl is-active "$SHARD_UNIT" > "$BACKUP_DIR/shard.active" 2>/dev/null || true
systemctl is-enabled "$SHARD_UNIT" > "$BACKUP_DIR/shard.enabled" 2>/dev/null || true
capture_running_bot_ids "$BACKUP_DIR/running-bot-ids"
capture_moved_running_bot_ids "$BACKUP_DIR/moved-running-bot-ids" "$OWNER_SCOPE"
: > "$BACKUP_DIR/backup.complete"

ROLLBACK_ARMED=1
PRIMARY_TMP=""
SHARD_TMP=""
SUDOERS_TMP=""
cleanup_temps() {
	[ -z "$PRIMARY_TMP" ] || rm -f -- "$PRIMARY_TMP"
	[ -z "$SHARD_TMP" ] || rm -f -- "$SHARD_TMP"
	[ -z "$SUDOERS_TMP" ] || rm -f -- "$SUDOERS_TMP"
}
on_failure() {
	local status="$1" line="$2"
	trap - ERR INT TERM
	echo "Cutover failed at line $line (exit $status). Rolling back automatically." >&2
	cleanup_temps
	if [ "$ROLLBACK_ARMED" -eq 1 ]; then
		restore_from_backup automatic || echo "CRITICAL: automatic rollback needs manual attention; backup: $BACKUP_DIR" >&2
	fi
	exit "$status"
}
trap 'on_failure $? $LINENO' ERR
trap 'on_failure 130 $LINENO' INT TERM

echo "=== 1/7: build disjoint environment files ==="
PRIMARY_TMP=$(mktemp /etc/linebot/worker.env.tmp.XXXXXX)
SHARD_TMP=$(mktemp /etc/linebot/worker-shard-b.env.tmp.XXXXXX)
OWNER_ROUTES=$(printf '%s' "$OWNER_SCOPE" | awk -F, '{ for (i=1; i<=NF; i++) printf "%s%s=http://127.0.0.1:8792", (i > 1 ? "," : ""), $i }')
CONTROL_PLANE_TOKEN=$("$BUN" --no-env-file -e 'import { randomBytes } from "node:crypto"; console.log(randomBytes(32).toString("hex"))')
[ "${#CONTROL_PLANE_TOKEN}" -ge 32 ]

# Rebuild both files from one secret-bearing source, but strip every topology
# and fast-poll key first. This makes reruns idempotent and prevents an old
# release-local experiment from leaking a second copy of a setting into either
# service. The fresh token is never printed and is installed mode 0640 below.
sed -E '/^[[:space:]]*(WORKER_ID|WORKER_OWNER_(SCOPE|EXCLUDE|ROUTES)|CONTROL_PLANE_(URL|TOKEN)|SQUARE_FAST_POLL_INTERVAL_MS|SQUARE_FAST_POLL_ALLOW_50MS)=/d' "$PRIMARY_ENV" > "$PRIMARY_TMP"
printf '\nWORKER_ID=linebot-worker-2\nWORKER_OWNER_EXCLUDE=%s\nWORKER_OWNER_ROUTES=%s\nCONTROL_PLANE_TOKEN=%s\nSQUARE_FAST_POLL_INTERVAL_MS=100\n' \
	"$OWNER_SCOPE" "$OWNER_ROUTES" "$CONTROL_PLANE_TOKEN" >> "$PRIMARY_TMP"
sed -E '/^[[:space:]]*(PORT|DISPATCH_ADDR|WORKER_ID|WORKER_OWNER_(SCOPE|EXCLUDE|ROUTES)|CONTROL_PLANE_(URL|TOKEN)|SQUARE_FAST_POLL_INTERVAL_MS|SQUARE_FAST_POLL_ALLOW_50MS)=/d' "$PRIMARY_TMP" > "$SHARD_TMP"
printf '\nPORT=8792\nDISPATCH_ADDR=127.0.0.1:4791\nWORKER_ID=linebot-worker-shard-b\nWORKER_OWNER_SCOPE=%s\nCONTROL_PLANE_URL=http://127.0.0.1:8791\nCONTROL_PLANE_TOKEN=%s\nSQUARE_FAST_POLL_INTERVAL_MS=50\nSQUARE_FAST_POLL_ALLOW_50MS=1\n' \
	"$OWNER_SCOPE" "$CONTROL_PLANE_TOKEN" >> "$SHARD_TMP"

[ "$(grep -c '^WORKER_OWNER_EXCLUDE=' "$PRIMARY_TMP")" -eq 1 ]
[ "$(grep -c '^WORKER_ID=linebot-worker-2$' "$PRIMARY_TMP")" -eq 1 ]
[ "$(grep -c '^WORKER_OWNER_SCOPE=' "$PRIMARY_TMP" || true)" -eq 0 ]
[ "$(grep -c '^WORKER_OWNER_ROUTES=' "$PRIMARY_TMP")" -eq 1 ]
[ "$(grep -c '^CONTROL_PLANE_URL=' "$PRIMARY_TMP" || true)" -eq 0 ]
[ "$(grep -c '^CONTROL_PLANE_TOKEN=' "$PRIMARY_TMP")" -eq 1 ]
[ "$(grep -c '^SQUARE_FAST_POLL_INTERVAL_MS=100$' "$PRIMARY_TMP")" -eq 1 ]
[ "$(grep -c '^SQUARE_FAST_POLL_ALLOW_50MS=' "$PRIMARY_TMP" || true)" -eq 0 ]
[ "$(grep -c '^WORKER_OWNER_SCOPE=' "$SHARD_TMP")" -eq 1 ]
[ "$(grep -c '^WORKER_OWNER_EXCLUDE=' "$SHARD_TMP" || true)" -eq 0 ]
[ "$(grep -c '^WORKER_OWNER_ROUTES=' "$SHARD_TMP" || true)" -eq 0 ]
[ "$(grep -c '^CONTROL_PLANE_URL=http://127.0.0.1:8791$' "$SHARD_TMP")" -eq 1 ]
[ "$(grep -c '^CONTROL_PLANE_TOKEN=' "$SHARD_TMP")" -eq 1 ]
[ "$(grep -c '^SQUARE_FAST_POLL_INTERVAL_MS=50$' "$SHARD_TMP")" -eq 1 ]
[ "$(grep -c '^SQUARE_FAST_POLL_ALLOW_50MS=1$' "$SHARD_TMP")" -eq 1 ]

install -o root -g linebot -m 640 "$PRIMARY_TMP" "$PRIMARY_ENV"
install -o root -g linebot -m 640 "$SHARD_TMP" "$SHARD_ENV"
rm -f -- "$PRIMARY_TMP" "$SHARD_TMP"
PRIMARY_TMP=""
SHARD_TMP=""

echo "=== 2/7: install units that disable release-local .env loading ==="
install -o root -g root -m 644 "$CURRENT_RELEASE/deploy/server2/linebot-worker.service" "$PRIMARY_UNIT_FILE"
install -o root -g root -m 644 "$CURRENT_RELEASE/deploy/server2/linebot-worker-shard-b.service" "$SHARD_UNIT_FILE"
grep -q -- '--no-env-file' "$PRIMARY_UNIT_FILE"
grep -q -- '--no-env-file' "$SHARD_UNIT_FILE"

echo "=== 3/7: install restricted deploy permission ==="
SUDOERS_TMP=$(mktemp /etc/sudoers.d/linebot-worker-shard-b.tmp.XXXXXX)
printf '%s\n' 'linebot ALL=(root) NOPASSWD: /usr/bin/systemctl restart linebot-worker-shard-b, /usr/bin/systemctl status linebot-worker-shard-b, /usr/bin/systemctl is-active linebot-worker-shard-b, /usr/bin/systemctl is-enabled linebot-worker-shard-b' > "$SUDOERS_TMP"
chmod 440 "$SUDOERS_TMP"
visudo -cf "$SUDOERS_TMP" >/dev/null
install -o root -g root -m 440 "$SUDOERS_TMP" "$SUDOERS_FILE"
rm -f -- "$SUDOERS_TMP"
SUDOERS_TMP=""
visudo -c >/dev/null

echo "=== 4/7: arm the shard gate and boot-time enablement ==="
touch "$SHARD_GATE"
chown root:root "$SHARD_GATE"
chmod 600 "$SHARD_GATE"
systemctl daemon-reload
systemctl enable "$SHARD_UNIT" >/dev/null

echo "=== 5/7: stop before moving ownership (no duplicate LINE sessions) ==="
systemctl stop "$SHARD_UNIT" 2>/dev/null || true
systemctl stop "$PRIMARY_UNIT"
[ "$(systemctl is-active "$PRIMARY_UNIT" 2>/dev/null || true)" != "active" ]
[ "$(systemctl is-active "$SHARD_UNIT" 2>/dev/null || true)" != "active" ]
# Graceful stop may mark sessions offline. Restore only the exact bot ids that
# were running before the stop; scope filters decide which process resumes each.
mark_bot_ids_for_resume "$BACKUP_DIR/running-bot-ids"

wait_active() {
	local unit="$1"
	for _ in $(seq 1 30); do
		[ "$(systemctl is-active "$unit" 2>/dev/null || true)" = "active" ] && return 0
		sleep 1
	done
	return 1
}

wait_port() {
	local port="$1"
	for _ in $(seq 1 30); do
		ss -H -ltn | awk -v suffix=":$port" '$4 ~ suffix "$" { found=1 } END { exit !found }' && return 0
		sleep 1
	done
	return 1
}

assert_effective_scope() {
	local unit="$1" expected_key="$2" expected_value="$3" forbidden_key="$4" pid actual forbidden
	pid=$(systemctl show -p MainPID --value "$unit")
	[ "$pid" -gt 0 ]
	actual=$(tr '\0' '\n' < "/proc/$pid/environ" | grep "^${expected_key}=" | cut -d= -f2-)
	forbidden=$(tr '\0' '\n' < "/proc/$pid/environ" | grep "^${forbidden_key}=" | cut -d= -f2- || true)
	[ "$actual" = "$expected_value" ]
	[ -z "$forbidden" ]
}

assert_effective_value() {
	local unit="$1" expected_key="$2" expected_value="$3" pid actual
	pid=$(systemctl show -p MainPID --value "$unit")
	[ "$pid" -gt 0 ]
	actual=$(tr '\0' '\n' < "/proc/$pid/environ" | grep "^${expected_key}=" | cut -d= -f2-)
	[ "$actual" = "$expected_value" ]
}

echo "=== 6/7: start the primary control plane, then shard B ==="
systemctl reset-failed "$SHARD_UNIT" "$PRIMARY_UNIT" 2>/dev/null || true
systemctl start "$PRIMARY_UNIT"
wait_active "$PRIMARY_UNIT"
wait_port 8791
assert_effective_scope "$PRIMARY_UNIT" WORKER_OWNER_EXCLUDE "$OWNER_SCOPE" WORKER_OWNER_SCOPE
assert_effective_value "$PRIMARY_UNIT" WORKER_ID linebot-worker-2
assert_effective_value "$PRIMARY_UNIT" WORKER_OWNER_ROUTES "$OWNER_ROUTES"
assert_effective_value "$PRIMARY_UNIT" CONTROL_PLANE_TOKEN "$CONTROL_PLANE_TOKEN"
assert_effective_value "$PRIMARY_UNIT" SQUARE_FAST_POLL_INTERVAL_MS 100

systemctl start "$SHARD_UNIT"
wait_active "$SHARD_UNIT"
wait_port 8792
assert_effective_scope "$SHARD_UNIT" WORKER_OWNER_SCOPE "$OWNER_SCOPE" WORKER_OWNER_EXCLUDE
assert_effective_value "$SHARD_UNIT" WORKER_ID linebot-worker-shard-b
assert_effective_value "$SHARD_UNIT" CONTROL_PLANE_URL http://127.0.0.1:8791
assert_effective_value "$SHARD_UNIT" CONTROL_PLANE_TOKEN "$CONTROL_PLANE_TOKEN"
assert_effective_value "$SHARD_UNIT" SQUARE_FAST_POLL_INTERVAL_MS 50
assert_effective_value "$SHARD_UNIT" SQUARE_FAST_POLL_ALLOW_50MS 1

echo "=== 7/7: wait for every transferred session that was running ==="
EXPECTED_MOVED=$(cat "$BACKUP_DIR/moved-running-bot-ids")
if [ -n "$EXPECTED_MOVED" ]; then
	MISSING="$EXPECTED_MOVED"
	for _ in $(seq 1 120); do
		MISSING=$(LINEBOT_DB_PATH="$DB_PATH" LINEBOT_EXPECTED_IDS="$EXPECTED_MOVED" "$BUN" --no-env-file -e '
			import { Database } from "bun:sqlite";
			const expected = (process.env.LINEBOT_EXPECTED_IDS ?? "").split(",").map(Number).filter(Number.isInteger);
			const db = new Database(process.env.LINEBOT_DB_PATH!, { readonly: true });
			const online = new Set((db.query("SELECT id FROM bots WHERE status = '\''online'\''").all() as Array<{id:number}>).map((row) => row.id));
			console.log(expected.filter((id) => !online.has(id)).join(","));
			db.close();
		')
		[ -z "$MISSING" ] && break
		sleep 1
	done
	if [ -n "$MISSING" ]; then
		echo "ERROR: transferred bots did not return online within 120s: $MISSING" >&2
		false
	fi
fi

ROLLBACK_ARMED=0
trap - ERR INT TERM

echo ""
echo "Cutover complete:"
echo "  primary WORKER_OWNER_EXCLUDE=$OWNER_SCOPE (port 8791)"
echo "  shard-b WORKER_OWNER_SCOPE=$OWNER_SCOPE (port 8792)"
echo "  primary routes owner API calls to shard B; shard events relay to primary"
echo "  shard 50ms is effective only with exactly one live LINE session; otherwise runtime uses 100ms"
echo "  rollback backup: $BACKUP_DIR"
echo ""
echo "Manual rollback:"
echo "  sudo $0 --rollback $BACKUP_DIR"
