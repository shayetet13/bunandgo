import { timingSafeEqual } from "node:crypto";
import {
	decodeDispatchRequest,
	encodeDispatchResponse,
} from "./binary-protocol.ts";
import { H2_LANE_ROLE_HEADER, type LaneStat } from "./h2-lanes.ts";

const TOKEN_HEADER = "x-lane-node-token";
const MAX_DISPATCH_BYTES = 16 << 20;

type LaneTransport = (
	info: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response | undefined> | Response | undefined;

export interface LaneNodeServerOptions {
	token: string;
	nodeId: string;
	origin: string;
	laneFetch: LaneTransport;
	laneStats: () => LaneStat[];
}

function validToken(actual: string | null, expected: string): boolean {
	if (!actual) return false;
	const left = Buffer.from(actual);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}

function unauthorized(): Response {
	return new Response("forbidden", { status: 403 });
}

function responseHeaders(response: Response): Record<string, string[]> {
	const headers: Record<string, string[]> = {};
	response.headers.forEach((value, key) => {
		(headers[key] ??= []).push(value);
	});
	return headers;
}

/**
 * Transport-only internal API. It accepts already-encoded LINE requests and
 * never parses bot credentials, rules, or protocol payloads.
 */
export function createLaneNodeHandler(options: LaneNodeServerOptions): (request: Request) => Promise<Response> {
	const allowedOrigin = new URL(options.origin).origin;
	return async (request: Request): Promise<Response> => {
		const endpoint = new URL(request.url);
		if (endpoint.pathname === "/healthz") {
			const lanes = options.laneStats();
			return Response.json({ ok: lanes.some((lane) => lane.state === "ready") });
		}
		if (!validToken(request.headers.get(TOKEN_HEADER), options.token)) return unauthorized();
		if (endpoint.pathname === "/v1/stats" && request.method === "GET") {
			return Response.json({ nodeId: options.nodeId, sampledAt: Date.now(), lanes: options.laneStats() });
		}
		if (endpoint.pathname !== "/v1/dispatch" || request.method !== "POST") {
			return new Response("not found", { status: 404 });
		}
		const declaredLength = Number(request.headers.get("content-length") ?? 0);
		if (declaredLength > MAX_DISPATCH_BYTES) return new Response("request too large", { status: 413 });

		let dispatch;
		try {
			dispatch = decodeDispatchRequest(new Uint8Array(await request.arrayBuffer()));
		} catch {
			return new Response("invalid dispatch frame", { status: 400 });
		}
		let target: URL;
		try {
			target = new URL(dispatch.url);
		} catch {
			return new Response("invalid target", { status: 400 });
		}
		if (target.origin !== allowedOrigin || dispatch.method.toUpperCase() !== "POST") {
			return new Response("target not allowed", { status: 403 });
		}
		const role = dispatch.headers[H2_LANE_ROLE_HEADER]?.toLowerCase();
		if (role !== "poll" && role !== "send") {
			return new Response("lane role required", { status: 400 });
		}

		const startedAt = performance.now();
		try {
			const response = await options.laneFetch(target, {
				method: dispatch.method,
				headers: dispatch.headers,
				body: dispatch.body,
				signal: request.signal,
			});
			if (!response) {
				return new Response("no eligible lane", {
					status: 503,
					headers: { "x-lane-node-not-started": "1" },
				});
			}
			const body = new Uint8Array(await response.arrayBuffer());
			const wire = encodeDispatchResponse({
				status: response.status,
				headers: responseHeaders(response),
				body,
				upstreamMs: performance.now() - startedAt,
				goPrepMs: 0,
			});
			return new Response(wire.buffer as ArrayBuffer, {
				status: 200,
				headers: { "content-type": "application/octet-stream" },
			});
		} catch (error) {
			// Once a stream opens, retrying elsewhere could duplicate a reply.
			// The coordinator treats this as an ambiguous terminal failure.
			console.error("[lane-node] upstream dispatch failed", error instanceof Error ? error.message : String(error));
			return new Response("upstream dispatch failed", { status: 502 });
		}
	};
}

export { TOKEN_HEADER as LANE_NODE_TOKEN_HEADER };
