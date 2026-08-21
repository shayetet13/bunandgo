/**
 * Entry point for the lane-relay service — a separate deployable (its own
 * systemd unit, its own box) that owns zero LINE sessions/bots. It exists
 * purely to run a second, physically independent h2-lanes pool that the main
 * backend (server2) can hand overflow sends/polls to when its own pool is
 * saturated. See ARCHITECTURE.md's h2-lanes section for what a "lane" is;
 * this process just runs that same pool on a different box.
 *
 * Deliberately NOT `../index.ts`: that entrypoint spawns the Go sender,
 * validates worker-topology.json, and imports the full bots/auth/users API —
 * all of that assumes a bot-owning process. This box needs none of it.
 */
import { ensureLanes } from "../dispatch/h2-lanes.ts";
import { relayConfig } from "./config.ts";
import { relayRoute } from "./dispatch-route.ts";
import { startLaneRelayReporting } from "./report-client.ts";

for (const origin of relayConfig.lineOrigins) {
	ensureLanes(origin).catch((error) => {
		console.error(`lane relay: failed to warm ${origin}:`, error instanceof Error ? error.message : error);
	});
}

export const server = Bun.serve({
	hostname: relayConfig.bindHost,
	port: relayConfig.port,
	fetch: relayRoute.fetch,
});

console.log(
	`lane-relay: listening on http://${relayConfig.bindHost}:${relayConfig.port} as worker "${relayConfig.workerId}"`,
);

startLaneRelayReporting();
