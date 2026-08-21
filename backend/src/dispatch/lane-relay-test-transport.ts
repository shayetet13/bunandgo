import { AsyncLocalStorage } from "node:async_hooks";
import { attachRawDispatchBody } from "./raw-response.ts";
import { dispatchViaRelay } from "./remote-lane.ts";
import type { LaneRole } from "./h2-lanes.ts";

/**
 * TEMPORARY — supports the lane-relay ban-risk test only (see
 * `testLaneRelayBurst` in session-manager.ts). Remove alongside that
 * function once the go/no-go decision on routing real traffic through the
 * lane relay is made.
 *
 * AsyncLocalStorage, not a module-level flag: `session-manager.ts` runs many
 * bots' sends concurrently in one process, and a plain flag set before one
 * bot's sendMessage call would leak into any other bot's send that happens
 * to interleave on the event loop while this one is in flight. The context
 * scopes strictly to the async call tree started by `runWithLaneRelayTest`.
 */
const relayTestContext = new AsyncLocalStorage<true>();

export function runWithLaneRelayTest<T>(fn: () => Promise<T>): Promise<T> {
	return relayTestContext.run(true, fn);
}

export function isLaneRelayTestActive(): boolean {
	return relayTestContext.getStore() === true;
}

// Server3 (debian-ap-northeast), reached over the wg1 tunnel only — never
// the public internet. Hardcoded rather than an env var on purpose: this
// whole file is temporary, and getting one more env var wired onto Server 2
// costs a full worker restart same as any other code change would. (The
// production path in remote-lane.ts uses its own LINE_RELAY_* env vars —
// deliberately a separate credential from this test-only one.)
const RELAY_DISPATCH_CONFIG = {
	url: "http://10.90.0.2:8795/dispatch",
	token: "f23bbe09f6dc7e45557d0b86754e8ef725d228cd7ea76fd64338ca6c7f9c8307",
};

interface RelayStatsLane {
	origin: string;
	state: string;
	applicationRttMs?: number;
}

/**
 * Reads server3's own current best measured send RTT for legy.line-apps.com
 * so a caller can gate a send on it *before* dispatching — the same
 * predictive, most-recent-measurement approach the production ceiling in
 * h2-lanes.ts uses locally. Returns undefined when the relay is unreachable
 * or has no ready lane yet, which a caller should treat as "not eligible"
 * rather than guessing.
 */
export async function bestKnownRelayRttMs(): Promise<number | undefined> {
	try {
		const response = await fetch("http://10.90.0.2:8795/stats", { signal: AbortSignal.timeout(3_000) });
		if (!response.ok) return undefined;
		const data = await response.json() as { lanes: RelayStatsLane[] };
		const eligible = data.lanes.filter((lane) =>
			lane.origin === "https://legy.line-apps.com" && lane.state === "ready" && lane.applicationRttMs !== undefined
		);
		if (eligible.length === 0) return undefined;
		return Math.min(...eligible.map((lane) => lane.applicationRttMs!));
	} catch {
		return undefined;
	}
}

export async function fetchViaLaneRelayTest(
	info: RequestInfo | URL,
	init: RequestInit | undefined,
	role: LaneRole,
): Promise<Response> {
	const response = await dispatchViaRelay(RELAY_DISPATCH_CONFIG, info, init, role);
	// The test harness has no "fall back to somewhere else" to retry against —
	// an unreachable relay is itself the answer it needs to report, not a
	// silent no-op.
	if (!response) throw new Error("lane relay test: could not reach the relay box at all");
	const body = new Uint8Array(await response.arrayBuffer());
	return attachRawDispatchBody(new Response(body as BodyInit, { status: response.status, headers: response.headers }), body);
}
