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
import { primeLanes } from "../dispatch/h2-lanes.ts";
import { relayConfig } from "./config.ts";
import { relayRoute } from "./dispatch-route.ts";
import { startLaneRelayReporting } from "./report-client.ts";

// Do not accept relay work while Server 3 only has open sockets and PING
// measurements. HEAD /SQ1 exercises every owned H2 stream once, so the first
// real poll does not pay connection/application-path setup. It deliberately
// remains distinct from a real authenticated application measurement.
await Promise.all(relayConfig.lineOrigins.map((origin) => primeLanes(origin)));

export const server = Bun.serve({
	hostname: relayConfig.bindHost,
	port: relayConfig.port,
	fetch: relayRoute.fetch,
});

console.log(`lane-relay: listening on http://${relayConfig.bindHost}:${relayConfig.port} as worker "${relayConfig.workerId}"`);

startLaneRelayReporting();
