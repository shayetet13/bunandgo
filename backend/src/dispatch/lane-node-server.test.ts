import { describe, expect, test } from "bun:test";
import { encodeDispatchRequest, decodeDispatchResponse } from "./binary-protocol.ts";
import { H2_LANE_ROLE_HEADER, type LaneStat } from "./h2-lanes.ts";
import { createLaneNodeHandler, LANE_NODE_TOKEN_HEADER } from "./lane-node-server.ts";

const TOKEN = "t".repeat(48);
const stat: LaneStat = {
	origin: "https://legy.line-apps.com",
	id: 0,
	state: "ready",
	inFlight: 0,
	lastOkAt: 100,
	lastSendOkAt: 0,
	lastPollOkAt: 100,
	applicationRttMs: 17,
	applicationSampleAt: 100,
	routingEligible: true,
	consecutiveFailures: 0,
	openedAt: 1,
};

function request(path: string, init?: RequestInit): Request {
	return new Request(`http://lane.internal${path}`, init);
}

describe("lane node internal API", () => {
	test("keeps diagnostics authenticated except for the bounded health result", async () => {
		const handler = createLaneNodeHandler({
			token: TOKEN,
			nodeId: "node-b",
			origin: stat.origin,
			laneFetch: () => undefined,
			laneStats: () => [stat],
		});
		expect((await handler(request("/healthz"))).status).toBe(200);
		expect((await handler(request("/v1/stats"))).status).toBe(403);
		const response = await handler(request("/v1/stats", {
			headers: { [LANE_NODE_TOKEN_HEADER]: TOKEN },
		}));
		expect((await response.json() as { nodeId: string }).nodeId).toBe("node-b");
	});

	test("relays one allowed prebuilt LINE request and returns the binary response", async () => {
		let calls = 0;
		const handler = createLaneNodeHandler({
			token: TOKEN,
			nodeId: "node-b",
			origin: stat.origin,
			laneStats: () => [stat],
			laneFetch: async (_target, init) => {
				calls++;
				expect(new Headers(init?.headers).get(H2_LANE_ROLE_HEADER)).toBe("send");
				return new Response(new Uint8Array([7, 8]), { status: 201, headers: { "x-upstream": "line" } });
			},
		});
		const wire = encodeDispatchRequest({
			method: "POST",
			url: `${stat.origin}/SQ1`,
			headers: { [H2_LANE_ROLE_HEADER]: "send", "x-line-access": "secret" },
			body: new Uint8Array([1, 2]),
		});
		const response = await handler(request("/v1/dispatch", {
			method: "POST",
			headers: { [LANE_NODE_TOKEN_HEADER]: TOKEN },
			body: wire.buffer as ArrayBuffer,
		}));
		expect(response.status).toBe(200);
		const decoded = decodeDispatchResponse(new Uint8Array(await response.arrayBuffer()));
		expect(decoded.status).toBe(201);
		expect(decoded.body).toEqual(new Uint8Array([7, 8]));
		expect(calls).toBe(1);
	});

	test("blocks SSRF, missing roles, and ambiguous retries", async () => {
		const handler = createLaneNodeHandler({
			token: TOKEN,
			nodeId: "node-b",
			origin: stat.origin,
			laneStats: () => [stat],
			laneFetch: () => { throw new Error("stream reset"); },
		});
		const dispatch = async (url: string, headers: Record<string, string>) => handler(request("/v1/dispatch", {
			method: "POST",
			headers: { [LANE_NODE_TOKEN_HEADER]: TOKEN },
			body: encodeDispatchRequest({ method: "POST", url, headers, body: new Uint8Array() }).buffer as ArrayBuffer,
		}));
		expect((await dispatch("https://example.com/SQ1", { [H2_LANE_ROLE_HEADER]: "send" })).status).toBe(403);
		expect((await dispatch(`${stat.origin}/SQ1`, {})).status).toBe(400);
		expect((await dispatch(`${stat.origin}/SQ1`, { [H2_LANE_ROLE_HEADER]: "send" })).status).toBe(502);
	});
});
