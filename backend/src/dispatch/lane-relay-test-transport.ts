import { AsyncLocalStorage } from "node:async_hooks";
import { attachRawDispatchBody } from "./raw-response.ts";
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
// costs a full worker restart same as any other code change would.
const RELAY_DISPATCH_URL = "http://10.90.0.2:8795/dispatch";
const RELAY_DISPATCH_TOKEN = "f23bbe09f6dc7e45557d0b86754e8ef725d228cd7ea76fd64338ca6c7f9c8307";

function headersToRecord(source: RequestInit["headers"]): Record<string, string> {
	const headers: Record<string, string> = {};
	if (!source) return headers;
	if (source instanceof Headers) {
		source.forEach((value, key) => { headers[key] = value; });
		return headers;
	}
	if (Array.isArray(source)) {
		for (const [key, value] of source) headers[key] = value;
		return headers;
	}
	for (const [key, value] of Object.entries(source)) {
		if (value !== undefined) headers[key] = String(value);
	}
	return headers;
}

async function bodyToBase64(body: BodyInit | null | undefined): Promise<string | undefined> {
	if (body === null || body === undefined) return undefined;
	if (body instanceof Uint8Array) return Buffer.from(body).toString("base64");
	if (typeof body === "string") return Buffer.from(body, "utf8").toString("base64");
	const buf = new Uint8Array(await new Response(body).arrayBuffer());
	return Buffer.from(buf).toString("base64");
}

/**
 * Mirrors laneFetch()'s contract as closely as a network hop allows:
 * resolves with a real Response only when the relay box confirms it got a
 * response from LINE. Any ambiguity (relay unreachable, malformed reply)
 * throws rather than guessing — this is a diagnostic tool, not a retry path,
 * and a false "undelivered" here is far safer than a false "delivered".
 */
export async function fetchViaLaneRelayTest(
	info: RequestInfo | URL,
	init: RequestInit | undefined,
	role: LaneRole,
): Promise<Response> {
	const url = info instanceof URL ? info : new URL(typeof info === "string" ? info : info.url);
	const response = await fetch(RELAY_DISPATCH_URL, {
		method: "POST",
		headers: { "content-type": "application/json", "x-lane-relay-token": RELAY_DISPATCH_TOKEN },
		body: JSON.stringify({
			method: init?.method ?? "GET",
			url: url.toString(),
			headers: headersToRecord(init?.headers),
			bodyBase64: await bodyToBase64(init?.body as BodyInit | null | undefined),
			role,
		}),
		signal: AbortSignal.timeout(20_000),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`lane relay test dispatch failed: HTTP ${response.status} ${text}`);
	}
	const payload = await response.json() as {
		status: number;
		headers: Record<string, string>;
		bodyBase64: string;
		error?: string;
	};
	if (payload.error) throw new Error(`lane relay test upstream error: ${payload.error}`);
	const bodyBytes = new Uint8Array(Buffer.from(payload.bodyBase64, "base64"));
	return attachRawDispatchBody(
		new Response(bodyBytes as BodyInit, { status: payload.status, headers: payload.headers }),
		bodyBytes,
	);
}
