import { createLaneNodeHandler } from "./dispatch/lane-node-server.ts";
import {
	ensureLanes,
	H2_LANE_ROLE_HEADER,
	laneFetch,
	laneStats,
	stopLanes,
} from "./dispatch/h2-lanes.ts";

const token = process.env.LANE_NODE_TOKEN?.trim();
if (!token || token.length < 32) throw new Error("LANE_NODE_TOKEN must contain at least 32 characters");

const origin = new URL(process.env.LANE_NODE_ORIGIN ?? "https://legy.line-apps.com").origin;
const nodeId = process.env.LANE_NODE_ID?.trim() || "lane-node";
const hostname = process.env.LANE_NODE_HOST?.trim() || "127.0.0.1";
const port = Math.max(1, Math.min(65_535, Number(process.env.LANE_NODE_PORT ?? 4891)));
const probeIntervalMs = Math.max(1_000, Number(process.env.LANE_NODE_PROBE_INTERVAL_MS ?? 1_000));

await ensureLanes(origin);
const handler = createLaneNodeHandler({ token, nodeId, origin, laneFetch, laneStats });
const server = Bun.serve({ hostname, port, fetch: handler });

// Transport-only probes classify every physical route without a LINE login.
// They are observability samples; production sends stay disabled at the
// coordinator until real poll canaries prove end-to-end latency.
let probing = false;
const probeTimer = setInterval(() => {
	if (probing) return;
	probing = true;
	void Promise.resolve(laneFetch(`${origin}/`, {
		method: "HEAD",
		headers: { [H2_LANE_ROLE_HEADER]: "poll" },
		signal: AbortSignal.timeout(5_000),
	})).catch((error) => {
		console.error("[lane-node] probe failed", error instanceof Error ? error.message : String(error));
	}).finally(() => {
		probing = false;
	});
}, probeIntervalMs);
probeTimer.unref?.();

console.log(`[lane-node] ${nodeId} listening on ${hostname}:${port} with origin ${origin}`);

function shutdown(): void {
	clearInterval(probeTimer);
	stopLanes();
	server.stop(true);
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
