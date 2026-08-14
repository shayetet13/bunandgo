#!/usr/bin/env bash
# Interleaved A/B latency measurement, executed on Server 2 itself.
#
# Everything that has to be accurate happens on the worker host: the window
# clock, the sleep, the database read, the config check. Run from a laptop
# this script does not measure there — it pipes itself into a shell on
# Server 2 and runs there, so nothing is timed across the SSH hop.
#
# That is not a stylistic choice. Measured 2026-08-09: the laptop's clock sat
# 344ms off Server 2's, and one SSH round trip cost 2.2 SECONDS. Window edges
# derived from a local `date` and compared against `latency_samples.ts` (which
# is the server's own `Date.now()`) are wrong by seconds, which silently drops
# or steals samples at the boundary of every window.
#
# Why interleave at all: reply latency on *identical* code has been observed
# between 18ms and 80ms within one afternoon. "Config A for ten minutes, then
# config B for ten minutes" measures the time of day as much as the config,
# and that is how two earlier tuning conclusions had to be thrown out.
#
#   1. collect baseline 10      <- current config
#   2. (flip config on Server 2, restart the worker)
#   3. collect reserved 10
#   4. (flip back, restart)
#   5. collect baseline 10      <- again, later in time
#   ... until each label has 50+ samples over 3+ windows
#   6. report
#
# Usage (from anywhere):
#   bash scripts/ab-latency.sh --worker primary collect <label> <minutes>
#   bash scripts/ab-latency.sh --worker shard-b config
#   bash scripts/ab-latency.sh --worker shard-b report
#   bash scripts/ab-latency.sh --worker shard-b reset

set -euo pipefail

DB="/opt/linebot/shared/worker.db"
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; DIM=$'\033[2m'; NC=$'\033[0m'

die() { echo "${RED}error:${NC} $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Dispatch: on the worker host this runs natively; anywhere else it re-executes
# itself on the worker host over stdin. Sending the script rather than
# installing it means the copy that runs can never drift from this file.
# ---------------------------------------------------------------------------
if [ ! -f "$DB" ]; then
	GATEWAY="admin@3.112.61.130"
	TARGET_HOST="linebot@10.77.0.2"
	TARGET_IP="10.77.0.2"
	SELF="${BASH_SOURCE[0]}"
	ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
	SRC_KEY="$ROOT/maxpc.pem"
	# ProxyCommand quoting breaks on the space in the repo path.
	KEY="${AB_LATENCY_KEY:-/tmp/ab-latency-key.pem}"

	[ -f "$SRC_KEY" ] || die "ssh key not found at $SRC_KEY"
	if [ ! -f "$KEY" ] || [ "$SRC_KEY" -nt "$KEY" ]; then
		cp "$SRC_KEY" "$KEY"
		chmod 600 "$KEY"
	fi

	echo "${DIM}running on Server 2 (${TARGET_HOST}) — all timing is server-side${NC}" >&2
	quoted=""
	for arg in "$@"; do quoted+="$(printf '%q ' "$arg")"; done
	# ServerAliveInterval keeps a long collect window from being dropped by an
	# idle NAT timeout; the work itself is already running on the far side.
	exec ssh -i "$KEY" \
		-o StrictHostKeyChecking=no \
		-o ConnectTimeout=10 \
		-o ServerAliveInterval=15 \
		-o ServerAliveCountMax=8 \
		-o ProxyCommand="ssh -i $KEY -W $TARGET_IP:22 $GATEWAY" \
		"$TARGET_HOST" "bash -s -- $quoted" < "$SELF"
fi

# ---------------------------------------------------------------------------
# From here down: running on Server 2.
# ---------------------------------------------------------------------------

WORKER="${AB_LATENCY_WORKER:-primary}"
if [ "${1:-}" = "--worker" ]; then
	[ "$#" -ge 2 ] || die "--worker needs primary or shard-b"
	WORKER="$2"
	shift 2
fi
case "$WORKER" in
	primary)
		UNIT="linebot-worker"
		ENV_FILE="/etc/linebot/worker.env"
		;;
	shard-b|shardb)
		WORKER="shard-b"
		UNIT="linebot-worker-shard-b"
		ENV_FILE="/etc/linebot/worker-shard-b.env"
		;;
	*) die "unknown worker '$WORKER' (use primary or shard-b)" ;;
esac
CSV="${AB_LATENCY_CSV:-$HOME/.ab-latency-${WORKER}.csv}"

worker_pid() {
	systemctl show -p MainPID --value "$UNIT" 2>/dev/null || echo 0
}

read_live_value() {
	local key="$1" pid
	pid=$(worker_pid)
	[ "$pid" -gt 0 ] || return 0
	tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep "^${key}=" | tail -1 | cut -d= -f2- || true
}

# latency_samples is shared by both processes. Restrict every measurement to
# bots owned by the selected process, otherwise primary traffic contaminates a
# shard-B arm (and vice versa) even though the live config label is correct.
sample_filter_sql() {
	local include exclude pid
	pid=$(worker_pid)
	[ "$pid" -gt 0 ] || die "$UNIT is not running; its owner scope cannot be proven"
	include=$(read_live_value WORKER_OWNER_SCOPE)
	exclude=$(read_live_value WORKER_OWNER_EXCLUDE)
	if [ -n "$include" ]; then
		printf '%s' "$include" | grep -Eq '^[1-9][0-9]*(,[1-9][0-9]*)*$' || die "invalid live WORKER_OWNER_SCOPE"
		printf ' AND bot_id IN (SELECT id FROM bots WHERE owner_user_id IN (%s))' "$include"
	elif [ -n "$exclude" ]; then
		printf '%s' "$exclude" | grep -Eq '^[1-9][0-9]*(,[1-9][0-9]*)*$' || die "invalid live WORKER_OWNER_EXCLUDE"
		printf ' AND bot_id IN (SELECT id FROM bots WHERE owner_user_id IS NULL OR owner_user_id NOT IN (%s))' "$exclude"
	fi
}

# The config the worker actually loaded, read from its own process environment
# rather than from a file we hope matches it. An env change needs a restart to
# take effect, and this is what catches the window labelled "reserved" that
# actually measured a worker nobody restarted.
read_config() {
	local pid
	pid="$(worker_pid)"
	if [ -z "$pid" ]; then echo "WORKER-NOT-RUNNING"; return 0; fi
	if [ "$pid" -le 0 ]; then echo "WORKER-NOT-RUNNING"; return 0; fi
	printf 'PID=%s WORKER=%s ' "$pid" "$WORKER"
	tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null \
		| grep -E '^(LINE_H2_LANES|LINE_H2_SEND_RESERVED_LANES|SQUARE_FAST_POLL_MAX_ROOMS|SQUARE_FAST_POLL_WORKERS|SQUARE_FAST_POLL_INTERVAL_MS|SQUARE_FAST_POLL_ALLOW_50MS)=' \
		| sort | paste -sd' ' - || echo "UNREADABLE"
}

cmd_config() {
	local config started
	config="$(read_config)"
	started="$(ps -o lstart= -p "$(worker_pid)" 2>/dev/null || echo unknown)"
	echo "worker        : $WORKER ($UNIT)"
	echo "worker config : ${config:-<none set, all defaults>}"
	echo "worker started: ${started}"
	echo "server time   : $(date '+%Y-%m-%d %H:%M:%S %Z')"
	echo
	echo "${DIM}defaults when unset: LINE_H2_LANES=6 LINE_H2_SEND_RESERVED_LANES=0"
	echo "                    SQUARE_FAST_POLL_MAX_ROOMS=1 SQUARE_FAST_POLL_WORKERS=1 SQUARE_FAST_POLL_INTERVAL_MS=100"
	echo "                    50ms is active only with SQUARE_FAST_POLL_ALLOW_50MS=1${NC}"
	echo
	echo "env source     : $ENV_FILE"
	echo "after editing  : sudo -n /usr/bin/systemctl restart $UNIT"
}

cmd_collect() {
	local label="${1:-}" minutes="${2:-}"
	[ -n "$label" ] || die "usage: collect <label> <minutes>"
	[ -n "$minutes" ] || die "usage: collect <label> <minutes>"
	case "$label" in *,*) die "label must not contain a comma";; esac
	case "$minutes" in *[!0-9]*|"") die "minutes must be a whole number";; esac
	[ -f "$DB" ] || die "database not found at $DB"

	local config start_ms
	config="$(read_config)"
	[ "$config" != "WORKER-NOT-RUNNING" ] || die "the worker is not running — nothing to measure"

	# Server clock, same source as latency_samples.ts.
	start_ms=$(date +%s%3N)
	echo "${GREEN}collecting${NC} label=${label} for ${minutes} min"
	echo "  config: ${config:-<all defaults>}"
	echo "  window opens at $(date '+%H:%M:%S') server time"
	echo

	local total=$(( minutes * 60 )) left
	left=$total
	while [ "$left" -gt 0 ]; do
		printf "\r  %s min remaining  " "$(( (left + 59) / 60 ))"
		if [ "$left" -gt 30 ]; then sleep 30; left=$(( left - 30 )); else sleep "$left"; left=0; fi
	done
	printf "\r%-40s\r" " "

	# A window that spans a restart belongs to neither label.
	local config_after
	config_after="$(read_config)"
	[ "$config_after" = "$config" ] || \
		die "config changed mid-window (before: '${config}' after: '${config_after}') — discard this run"

	local end_ms rows scope_filter
	end_ms=$(date +%s%3N)
	scope_filter=$(sample_filter_sql)
	rows="$(sqlite3 -noheader -separator ',' "$DB" \
		"SELECT surface, ROUND(latency_ms,2), COALESCE(ROUND(inbound_ms,2),'') \
		 FROM latency_samples \
		 WHERE source='auto' AND ts >= $start_ms AND ts <= $end_ms${scope_filter};" 2>/dev/null || true)"

	if [ -z "$rows" ]; then
		echo "${YELLOW}no replies happened in that window${NC} — nothing recorded."
		echo "a sample only exists when the bot actually answered a keyword."
		return 0
	fi

	[ -f "$CSV" ] || echo "label,window,surface,reply_ms,inbound_ms,config" > "$CSV"
	local n=0
	while IFS=, read -r surface reply inbound; do
		[ -n "$surface" ] || continue
		echo "${label},${start_ms},${surface},${reply},${inbound},${config// /;}" >> "$CSV"
		n=$(( n + 1 ))
	done <<< "$rows"

	echo "${GREEN}recorded ${n} sample(s)${NC} under label '${label}'"
	echo
	cmd_report
}

# Samples accumulate in latency_samples whether or not this tool is running,
# so a period the worker already spent on a known config does not need to be
# sat through again. Windows are 10-minute buckets of real sample time.
#
# Deliberately weaker than `collect`: nothing here can prove what the worker's
# environment was at the time, so rows are stamped `backfilled` rather than
# with a config read from the process. Only use it for a stretch you know was
# uniform — and never to manufacture the arm you are trying to prove.
cmd_backfill() {
	local label="${1:-}" hours="${2:-}"
	[ -n "$label" ] || die "usage: backfill <label> <hours>"
	[ -n "$hours" ] || die "usage: backfill <label> <hours>"
	case "$label" in *,*) die "label must not contain a comma";; esac
	case "$hours" in *[!0-9]*|"") die "hours must be a whole number";; esac
	[ -f "$DB" ] || die "database not found at $DB"

	local since_ms rows scope_filter
	since_ms=$(( $(date +%s%3N) - hours * 3600000 ))
	scope_filter=$(sample_filter_sql)
	rows="$(sqlite3 -noheader -separator ',' "$DB" \
		"SELECT surface, ROUND(latency_ms,2), COALESCE(ROUND(inbound_ms,2),''), (ts/600000)*600000 \
		 FROM latency_samples \
		 WHERE source='auto' AND ts >= $since_ms${scope_filter};" 2>/dev/null || true)"

	if [ -z "$rows" ]; then
		echo "${YELLOW}no replies in the last ${hours}h${NC} — nothing to backfill."
		return 0
	fi

	[ -f "$CSV" ] || echo "label,window,surface,reply_ms,inbound_ms,config" > "$CSV"
	local n=0
	while IFS=, read -r surface reply inbound window; do
		[ -n "$surface" ] || continue
		echo "${label},${window},${surface},${reply},${inbound},backfilled" >> "$CSV"
		n=$(( n + 1 ))
	done <<< "$rows"

	echo "${GREEN}backfilled ${n} sample(s)${NC} from the last ${hours}h under label '${label}'"
	echo "${DIM}stamped 'backfilled': the config at the time is asserted by you, not verified${NC}"
	echo
	cmd_report
}

# Percentile from sorted stdin. Prints "-" for an empty set.
pct() {
	awk -v p="$1" '{a[NR]=$1} END{
		if (NR==0) { print "-"; exit }
		i=int((p/100)*NR); if (i<1) i=1
		printf "%.1f", a[i]
	}'
}

column_of() { # $1 label, $2 surface, $3 field index
	awk -F, -v l="$1" -v s="$2" -v f="$3" \
		'NR>1 && $1==l && $3==s && $f!="" {print $f}' "$CSV" | sort -n
}

windows_of() {
	awk -F, -v l="$1" -v s="$2" 'NR>1 && $1==l && $3==s {print $2}' "$CSV" | sort -u | wc -l | tr -d ' '
}

cmd_report() {
	[ -f "$CSV" ] || { echo "no samples yet — run: collect <label> <minutes>"; return 0; }

	local labels surfaces
	labels="$(awk -F, 'NR>1 {print $1}' "$CSV" | sort -u)"
	surfaces="$(awk -F, 'NR>1 {print $3}' "$CSV" | sort -u)"
	[ -n "$labels" ] || { echo "no samples yet."; return 0; }

	for surface in $surfaces; do
		echo
		echo "${GREEN}== ${surface} ==${NC}"
		printf "  %-12s %5s %8s %10s %10s %12s %10s\n" \
			label n windows reply_p50 reply_p90 inbound_p50 race_p50
		for label in $labels; do
			local n r50 r90 i50 race50
			n="$(column_of "$label" "$surface" 4 | wc -l | tr -d ' ')"
			[ "$n" -gt 0 ] || continue
			r50="$(column_of "$label" "$surface" 4 | pct 50)"
			r90="$(column_of "$label" "$surface" 4 | pct 90)"
			i50="$(column_of "$label" "$surface" 5 | pct 50)"
			# The number that decides the race: LINE's delay handing us the
			# trigger plus our whole reply. Neither half alone is the story.
			race50="$(awk -F, -v l="$label" -v s="$surface" \
				'NR>1 && $1==l && $3==s && $5!="" {print $4+$5}' "$CSV" | sort -n | pct 50)"
			printf "  %-12s %5s %8s %10s %10s %12s %10s\n" \
				"$label" "$n" "$(windows_of "$label" "$surface")" "$r50" "$r90" "$i50" "$race50"
		done
	done

	echo
	echo "${DIM}reply   = our half, from receiving the trigger to LINE accepting the send"
	echo "inbound = how late LINE handed us the trigger (spans two clocks)"
	echo "race    = inbound + reply, the only number a rival bot competes on${NC}"
	echo

	local thin=0
	for surface in $surfaces; do
		for label in $labels; do
			local n w
			n="$(column_of "$label" "$surface" 4 | wc -l | tr -d ' ')"
			[ "$n" -gt 0 ] || continue
			w="$(windows_of "$label" "$surface")"
			if [ "$n" -lt 50 ] || [ "$w" -lt 3 ]; then
				echo "${YELLOW}thin:${NC} ${surface}/${label} — ${n} sample(s) over ${w} window(s)"
				thin=1
			fi
		done
	done
	if [ "$thin" -eq 1 ]; then
		echo
		echo "${YELLOW}Not enough to conclude anything.${NC} Aim for 50+ samples per label"
		echo "over 3+ alternating windows. A single convincing window is exactly how"
		echo "the last two tuning attempts produced results that did not hold."
	else
		echo "${GREEN}Sample counts are adequate.${NC} Treat a gap under ~3ms as noise:"
		echo "identical config has measured 17.8ms and 20.4ms minutes apart."
	fi
}

cmd_reset() {
	[ -f "$CSV" ] || { echo "nothing to reset."; return 0; }
	local n; n="$(( $(wc -l < "$CSV") - 1 ))"
	printf "discard %s recorded sample(s)? [y/N] " "$n"
	read -r reply
	case "$reply" in
		y|Y) rm -f "$CSV"; echo "cleared.";;
		*) echo "kept.";;
	esac
}

case "${1:-}" in
	collect) shift; cmd_collect "$@";;
	backfill) shift; cmd_backfill "$@";;
	report) cmd_report;;
	config) cmd_config;;
	reset) cmd_reset;;
	*)
		echo "usage:"
		echo "  bash scripts/ab-latency.sh --worker primary|shard-b collect <label> <minutes>"
		echo "  bash scripts/ab-latency.sh --worker primary|shard-b backfill <label> <hours>"
		echo "  bash scripts/ab-latency.sh --worker primary|shard-b report"
		echo "  bash scripts/ab-latency.sh --worker primary|shard-b config"
		echo "  bash scripts/ab-latency.sh --worker primary|shard-b reset"
		echo
		echo "runs on Server 2; selected-worker samples accumulate in ${CSV}"
		;;
esac
