/**
 * Config for the lane-relay service only (backend/src/relay/index.ts) — a
 * separate deployable that owns zero LINE sessions/bots, so it reads none of
 * the main backend's config.ts (that surface assumes a bot-owning process).
 */

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required for the lane relay service`);
	return value;
}

function parsePort(raw: string | undefined, fallback: number): number {
	const port = Number(raw ?? fallback);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`Invalid PORT env var: ${raw} (must be an integer 1-65535)`);
	}
	return port;
}

function parseOrigins(raw: string | undefined, fallback: string): string[] {
	const values = (raw ?? fallback)
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean)
		.map((value) => {
			const url = new URL(value);
			if (url.protocol !== "https:" || url.origin !== value.replace(/\/$/, "")) {
				throw new Error(`Invalid lane relay origin: ${value}`);
			}
			return url.origin;
		});
	if (values.length === 0) throw new Error("lane relay origin list cannot be empty");
	return [...new Set(values)];
}

const lineOrigins = parseOrigins(process.env.LANE_RELAY_LINE_ORIGINS, "https://legy.line-apps.com");

export const relayConfig = {
	port: parsePort(process.env.PORT, 8795),
	/** Binds loopback-only unless explicitly pointed at the tunnel address —
	 * a relay box has no browser-facing role, so failing closed here means a
	 * forgotten env var leaves it unreachable rather than publicly exposed. */
	bindHost: process.env.LANE_RELAY_BIND_HOST?.trim() || "127.0.0.1",
	workerId: process.env.WORKER_ID?.trim() || "lane-relay",
	/** Checked against `x-lane-relay-token` on incoming /dispatch calls. */
	dispatchToken: required("LANE_RELAY_DISPATCH_TOKEN"),
	/** Where this box POSTs its own lane stats — the control plane's
	 * `/internal/lane-relay-events` endpoint, reached over the tunnel. */
	reportUrl: required("LANE_RELAY_REPORT_URL"),
	reportToken: required("LANE_RELAY_REPORT_TOKEN"),
	reportIntervalMs: Math.max(1_000, Number(process.env.LANE_RELAY_REPORT_INTERVAL_MS ?? 1_000)),
	/** Origins that own dedicated H2 lanes. Production keeps all 32 on legy;
	 * gf is not part of the latency-sensitive workload. */
	lineOrigins,
	/** A rare login/control request may still name gf. Permit it to use the
	 * ordinary one-off fetch fallback without spending a permanent lane pool. */
	allowedOrigins: parseOrigins(process.env.LANE_RELAY_ALLOWED_ORIGINS, [...lineOrigins, "https://gf.line.naver.jp"].join(",")),
};
