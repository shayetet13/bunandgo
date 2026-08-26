#!/usr/bin/env bash
# Pins legy.line-apps.com in /etc/hosts to only the empirically-fast IPs in
# LINE's current DNS pool, keeping the hostname (SNI/Host) unchanged so the
# LINE TLS cert still validates normally. No application code is touched.
#
# Why: legy.line-apps.com is Akamai-fronted and CNAMEs to a small pool of
# LEGY (LINE's Erlang event gateway) IPs -- currently legy-jp-addr-ds, all in
# Japan. Measured 2026-08-25 from Server 2 with 8 samples/IP (full HTTPS
# request, not ping): 8 of 10 IPs answer in ~10-14ms, 2 answer in ~29-34ms.
# That's a clean bimodal split (~3x), not jitter -- almost certainly a
# farther POP within the same DNS name. Plain DNS round-robin gives an
# HTTP/2 lane roughly 1-in-5 odds of landing on a slow IP and staying there
# for the connection's whole lifetime (LINE_H2 lanes are long-lived).
#
# Confirmed empirically before relying on this: Bun's node:http2 connect()
# (the API h2-lanes.ts and linejs-core/base/push/conn.ts actually use)
# resolves through glibc getaddrinfo, which honors /etc/hosts -- proven via
# a pre-existing hosts entry (linebot-worker-2 -> 127.0.1.1) without ever
# touching the real legy.line-apps.com entry. See NETWORK-LANE-RACE.md.
#
# Idempotent and safe to run from cron: every run re-resolves the CURRENT
# pool from a public DoH resolver (bypasses our own pin, so it can't get
# stuck on a stale set) and re-measures. It only rewrites /etc/hosts if the
# fast set actually changed, and refuses to touch anything if measurement
# looks broken (see MIN_FAST_IPS below).
#
# Usage:
#   sudo bash pin-legy-fast-ips.sh              # measure, apply if changed
#   sudo bash pin-legy-fast-ips.sh --dry-run     # measure, report only
#   sudo bash pin-legy-fast-ips.sh --rollback    # restore the last backup
#
# Cron (re-verify every 6h in case LINE reshuffles its IP pool):
#   0 */6 * * * root /usr/bin/flock -n /var/lock/pin-legy.lock /opt/linebot/ops/pin-legy-fast-ips.sh >> /var/log/pin-legy-fast-ips.log 2>&1

set -euo pipefail

HOSTNAME_TARGET="legy.line-apps.com"
HOSTS_FILE="/etc/hosts"
BACKUP_DIR="/var/backups/legy-hosts-pin"
MARKER_BEGIN="# BEGIN legy-fast-ip-pin (managed by pin-legy-fast-ips.sh, do not hand-edit)"
MARKER_END="# END legy-fast-ip-pin"
SAMPLES_PER_IP="${LEGY_PIN_SAMPLES:-8}"
CURL_TIMEOUT="${LEGY_PIN_TIMEOUT:-5}"
SLOW_MULTIPLIER="${LEGY_PIN_SLOW_MULTIPLIER:-1.8}"
MIN_FAST_IPS="${LEGY_PIN_MIN_FAST_IPS:-4}"
DOH_RESOLVER="${LEGY_PIN_DOH_RESOLVER:-https://cloudflare-dns.com/dns-query}"

mode="apply"
case "${1:-}" in
	--dry-run) mode="dry-run" ;;
	--rollback) mode="rollback" ;;
	"") mode="apply" ;;
	*)
		echo "usage: $0 [--dry-run|--rollback]" >&2
		exit 2
		;;
esac

if [[ "$mode" != "rollback" && "$(id -u)" -ne 0 ]]; then
	echo "must run as root (writes $HOSTS_FILE)" >&2
	exit 1
fi

mkdir -p "$BACKUP_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

if [[ "$mode" == "rollback" ]]; then
	latest="$(ls -1t "$BACKUP_DIR"/hosts.*.bak 2>/dev/null | head -1 || true)"
	[[ -n "$latest" ]] || {
		echo "no backup found in $BACKUP_DIR" >&2
		exit 1
	}
	cp "$latest" "$HOSTS_FILE"
	echo "rolled back $HOSTS_FILE from $latest"
	exit 0
fi

command -v curl >/dev/null || {
	echo "curl required" >&2
	exit 127
}

# Resolve the CURRENT full IP pool via DNS-over-HTTPS to a public resolver,
# deliberately bypassing our own /etc/hosts pin -- otherwise a stale pin
# could never notice an IP LINE adds or retires later.
resolve_pool() {
	local qtype="$1" typenum="$2"
	curl -sS --max-time "$CURL_TIMEOUT" -H 'accept: application/dns-json' \
		"${DOH_RESOLVER}?name=${HOSTNAME_TARGET}&type=${qtype}" 2>/dev/null |
		grep -oE '"type":'"${typenum}"',"TTL":[0-9]+,"data":"[^"]+"' |
		grep -oE '"data":"[^"]+"' | cut -d'"' -f4
}

mapfile -t pool < <({ resolve_pool A 1; resolve_pool AAAA 28; } | sort -u)
if [[ "${#pool[@]}" -eq 0 ]]; then
	echo "DoH resolution returned nothing -- aborting without touching $HOSTS_FILE" >&2
	exit 1
fi

echo "resolved pool (${#pool[@]} IPs): ${pool[*]}"

declare -A median_of
samples_all=()
for ip in "${pool[@]}"; do
	times=()
	for ((i = 0; i < SAMPLES_PER_IP; i++)); do
		t="$(curl --resolve "${HOSTNAME_TARGET}:443:${ip}" -sS -o /dev/null -w '%{time_total}' \
			--max-time "$CURL_TIMEOUT" "https://${HOSTNAME_TARGET}/" 2>/dev/null || true)"
		[[ -n "$t" ]] && times+=("$(awk -v t="$t" 'BEGIN{printf "%.2f", t*1000}')")
	done
	if [[ "${#times[@]}" -eq 0 ]]; then
		echo "  $ip: no successful samples, treating as unreachable/slow" >&2
		median_of["$ip"]="999999"
		continue
	fi
	med="$(printf '%s\n' "${times[@]}" | sort -n | awk '{a[NR]=$1} END{print (NR%2==1)?a[(NR+1)/2]:(a[NR/2]+a[NR/2+1])/2}')"
	median_of["$ip"]="$med"
	samples_all+=("$med")
	printf '  %-28s median=%sms (n=%d)\n' "$ip" "$med" "${#times[@]}"
done

overall_median="$(printf '%s\n' "${samples_all[@]}" | sort -n | awk '{a[NR]=$1} END{print (NR%2==1)?a[(NR+1)/2]:(a[NR/2]+a[NR/2+1])/2}')"
[[ -n "$overall_median" ]] || {
	echo "no IP answered at all -- aborting without touching $HOSTS_FILE" >&2
	exit 1
}

# The SLOW_MULTIPLIER check below only catches outliers *within* this run's
# pool -- it cannot notice the whole pool shifting somewhere worse (e.g. a
# third-party passive-DNS source has separately shown this hostname can
# resolve to a Singapore cluster from some vantage points; every IP in that
# case would look uniformly "fast" relative to each other while all being
# ~30-50ms+ farther away than the Japan pool this host actually needs).
# ABSOLUTE_CEILING_MS guards against that: a Japan-hosted process should
# never legitimately see a median this high, regardless of how uniform the
# pool looks internally.
ABSOLUTE_CEILING_MS="${LEGY_PIN_ABSOLUTE_CEILING_MS:-25}"
if awk -v m="$overall_median" -v c="$ABSOLUTE_CEILING_MS" 'BEGIN{exit !(m>c)}'; then
	echo "overall median=${overall_median}ms exceeds absolute ceiling ${ABSOLUTE_CEILING_MS}ms -- pool may have shifted to a farther region (e.g. Singapore) rather than just containing a slow outlier; aborting without touching $HOSTS_FILE" >&2
	exit 1
fi

threshold="$(awk -v m="$overall_median" -v x="$SLOW_MULTIPLIER" 'BEGIN{printf "%.2f", m*x}')"
echo "overall median=${overall_median}ms, slow threshold=${threshold}ms (${SLOW_MULTIPLIER}x)"

fast_ips=()
slow_ips=()
for ip in "${pool[@]}"; do
	if awk -v v="${median_of[$ip]}" -v t="$threshold" 'BEGIN{exit !(v<=t)}'; then
		fast_ips+=("$ip")
	else
		slow_ips+=("$ip")
	fi
done

echo "fast (${#fast_ips[@]}): ${fast_ips[*]:-none}"
echo "slow/excluded (${#slow_ips[@]}): ${slow_ips[*]:-none}"

if [[ "${#fast_ips[@]}" -lt "$MIN_FAST_IPS" ]]; then
	echo "only ${#fast_ips[@]} fast IPs (< MIN_FAST_IPS=$MIN_FAST_IPS) -- looks like a bad measurement window, aborting without touching $HOSTS_FILE" >&2
	exit 1
fi

new_block="$MARKER_BEGIN
# Generated $(date -u +%FT%TZ). Excludes IPs measured >${SLOW_MULTIPLIER}x the
# pool median RTT (see scripts/pin-legy-fast-ips.sh for rationale). SNI/Host
# stays ${HOSTNAME_TARGET} so the LINE TLS cert still validates normally.
# Excluded this run: ${slow_ips[*]:-none}"
for ip in "${fast_ips[@]}"; do
	new_block="$new_block
$ip $HOSTNAME_TARGET"
done
new_block="$new_block
$MARKER_END"

current_block="$(awk -v begin="$MARKER_BEGIN" -v end="$MARKER_END" '$0==begin{f=1} f{print} $0==end{exit}' "$HOSTS_FILE" 2>/dev/null || true)"

if [[ "$current_block" == "$new_block" ]]; then
	echo "no change from current pin -- leaving $HOSTS_FILE untouched"
	exit 0
fi

if [[ "$mode" == "dry-run" ]]; then
	echo "--- dry-run: would write this block ---"
	echo "$new_block"
	exit 0
fi

cp "$HOSTS_FILE" "$BACKUP_DIR/hosts.${timestamp}.bak"
echo "backed up $HOSTS_FILE to $BACKUP_DIR/hosts.${timestamp}.bak"

if grep -qF "$MARKER_BEGIN" "$HOSTS_FILE"; then
	awk -v begin="$MARKER_BEGIN" -v end="$MARKER_END" -v block="$new_block" '
    $0==begin {print block; skip=1; next}
    $0==end {skip=0; next}
    skip {next}
    {print}
  ' "$HOSTS_FILE" >"${HOSTS_FILE}.tmp"
else
	cp "$HOSTS_FILE" "${HOSTS_FILE}.tmp"
	{
		echo ""
		echo "$new_block"
	} >>"${HOSTS_FILE}.tmp"
fi

mv "${HOSTS_FILE}.tmp" "$HOSTS_FILE"
echo "updated $HOSTS_FILE"

echo "--- verifying resolution now honors the pin ---"
getent ahosts "$HOSTNAME_TARGET" | awk '{print $1}' | sort -u

echo "--- verifying HTTPS still reaches LINE through the pinned IPs ---"
code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$CURL_TIMEOUT" "https://${HOSTNAME_TARGET}/" || echo "FAILED")"
echo "https://${HOSTNAME_TARGET}/ -> HTTP $code"

if [[ "$code" == "FAILED" ]]; then
	echo "WARNING: verification request failed after applying the pin -- rolling back automatically." >&2
	cp "$BACKUP_DIR/hosts.${timestamp}.bak" "$HOSTS_FILE"
	echo "rolled back to $BACKUP_DIR/hosts.${timestamp}.bak" >&2
	exit 1
fi

echo "OK. Existing established lanes keep whatever IP they already connected"
echo "through until they naturally reconnect (GOAWAY/idle/repairDegradedLane)"
echo "-- no service restart needed or recommended for this change."
