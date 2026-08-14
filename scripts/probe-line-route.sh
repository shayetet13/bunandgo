#!/usr/bin/env bash
# Low-rate route measurement for a LINE worker host.
#
# Run this independently on each candidate VPS; it does not pin an Akamai IP
# or alter the bot's connection pool. Each curl sample deliberately creates a
# fresh connection so its DNS/TCP/TLS timings are measurable. The bot itself
# continues to use its owned, persistent HTTP/2 lanes.
#
# Example:
#   LINE_PROBE_SAMPLES=60 LINE_PROBE_INTERVAL_SEC=60 bash scripts/probe-line-route.sh
#   LINE_PROBE_ENDPOINT=https://legy.line-apps.com/ bash scripts/probe-line-route.sh
set -euo pipefail

endpoint="${LINE_PROBE_ENDPOINT:-https://legy.line-apps.com/}"
samples="${LINE_PROBE_SAMPLES:-20}"
interval_sec="${LINE_PROBE_INTERVAL_SEC:-60}"
timeout_sec="${LINE_PROBE_TIMEOUT_SEC:-10}"

command -v curl >/dev/null || { echo "curl is required" >&2; exit 127; }
[[ "$samples" =~ ^[1-9][0-9]*$ ]] || { echo "LINE_PROBE_SAMPLES must be a positive integer" >&2; exit 2; }
[[ "$interval_sec" =~ ^[0-9]+$ ]] || { echo "LINE_PROBE_INTERVAL_SEC must be a non-negative integer" >&2; exit 2; }
[[ "$timeout_sec" =~ ^[1-9][0-9]*$ ]] || { echo "LINE_PROBE_TIMEOUT_SEC must be a positive integer" >&2; exit 2; }

authority="${endpoint#*://}"
authority="${authority%%/*}"
host="${authority%%:*}"
host="${host#[}"
host="${host%]}"
printf 'timestamp_utc,remote_ip,http_code,dns_ms,tcp_ms,tls_ms,ttfb_ms,total_ms\n'

for ((sample = 1; sample <= samples; sample++)); do
	# `time_connect` includes DNS; `time_appconnect` includes DNS+TCP. Report
	# the deltas so the columns are the individual stages requested.
	result="$(curl --silent --show-error --output /dev/null --location --max-time "$timeout_sec" \
		--write-out '%{remote_ip},%{http_code},%{time_namelookup},%{time_connect},%{time_appconnect},%{time_starttransfer},%{time_total}' \
		"$endpoint" 2>/dev/null || true)"
	if [[ -n "$result" ]]; then
		IFS=, read -r remote_ip http_code dns connect tls ttfb total <<< "$result"
		awk -v ts="$(date -u +%FT%TZ)" -v ip="$remote_ip" -v code="$http_code" \
			-v dns="$dns" -v connect="$connect" -v tls="$tls" -v ttfb="$ttfb" -v total="$total" \
			'BEGIN { printf "%s,%s,%s,%.2f,%.2f,%.2f,%.2f,%.2f\\n", ts, ip, code, dns*1000, (connect-dns)*1000, (tls-connect)*1000, (ttfb-tls)*1000, total*1000 }'
	else
		printf '%s,,,,,,,\n' "$(date -u +%FT%TZ)"
	fi
	if (( sample < samples && interval_sec > 0 )); then sleep "$interval_sec"; fi
done

# ICMP loss is only a supplementary signal: Akamai may rate-limit or ignore
# ping, so never use it to judge the HTTPS route by itself.
if command -v ping >/dev/null && [[ -n "$host" ]]; then
	echo >&2
	echo "supplementary ICMP check for $host (not an HTTPS-route verdict):" >&2
	ping -c 5 -W 1 "$host" >&2 || true
fi
