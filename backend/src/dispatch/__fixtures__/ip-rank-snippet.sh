#!/usr/bin/env bash
# The two pieces of scripts/pin-legy-fast-ips.sh that h2-lanes.ts depends on,
# copied verbatim: the fastest-median-first ordering of the pinned set, and the
# {ip: medianMs} ranking object. Kept in sync by ip-rank-file.test.ts.
set -euo pipefail

declare -A median_of=( [147.92.185.1]=14.20 [147.92.146.129]=9.80 [2400:dcc0::9]=31.00 [147.92.146.138]=12.50 )
pool=(147.92.185.1 147.92.146.129 2400:dcc0::9 147.92.146.138)
fast_ips=(147.92.185.1 147.92.146.129 147.92.146.138)

mapfile -t fast_ips < <(
	for ip in "${fast_ips[@]}"; do printf '%s\t%s\n' "${median_of[$ip]}" "$ip"; done | sort -n | cut -f2-
)
printf 'ORDER %s\n' "${fast_ips[*]}"

rank_json="{"
rank_sep=""
for ip in "${pool[@]}"; do
	[[ -n "${median_of[$ip]:-}" ]] || continue
	rank_json+="${rank_sep}\"${ip}\": ${median_of[$ip]}"
	rank_sep=", "
done
rank_json+="}"
printf 'JSON %s\n' "$rank_json"
