import type { FetchLike } from "../linejs-core/base/mod.ts";
import { decodeDispatchResponse, encodeDispatchRequest } from "./binary-protocol.ts";
import { markRelayDispatch, markRelayResult } from "../metrics/fast-path.ts";
import { attachRawDispatchBody } from "./raw-response.ts";
import { attachHotLineFetch } from "./direct-request.ts";
import { distributedLaneFetch } from "./remote-lanes.ts";
import { PREWARM_SQUARE_ACK, PREWARM_TALK_ACK } from "./prewarm-ack.ts";

export interface DispatchConfig {
	url: string;
	token: string;
}

export interface DispatchResult {
	status: number;
	headers: Record<string, string[]>;
	body: Uint8Array;
	tookMs: number;
	upstreamMs: number;
	goPrepMs: number;
}

/**
 * Fires one pre-built HTTP request at the Go sender over loopback and
 * returns the raw response. This is the only place in the backend that
 * talks to Go — Go itself has zero LINE-protocol knowledge, it just
 * relays bytes over a warm pooled connection (see backend/sender).
 */
async function dispatchJsonHttp(
	config: DispatchConfig,
	req: { method: string; url: string; headers: Record<string, string>; body: Uint8Array; signal?: AbortSignal },
): Promise<DispatchResult> {
	const start = performance.now();
	const encodeStart = performance.now();
	const wireBody = JSON.stringify({
		method: req.method,
		url: req.url,
		headers: Object.fromEntries(
			Object.entries(req.headers).map(([k, v]) => [k, [v]]),
		),
		bodyBase64: Buffer.from(req.body).toString("base64"),
	});
	markRelayDispatch(performance.now() - encodeStart);
	const res = await fetch(config.url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-dispatch-token": config.token,
		},
		body: wireBody,
		// Forwards the original request's AbortSignal.timeout(...) so Go's
		// outbound leg gets canceled too (its context is derived from this
		// same HTTP connection) — Go never needs to know the timeout value.
		signal: req.signal,
	});
	const tookMs = performance.now() - start;

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`dispatch relay error: HTTP ${res.status} ${text}`);
	}
	const payload = (await res.json()) as {
		status: number;
		headers: Record<string, string[]>;
		bodyBase64: string;
		tookNs: number;
		error?: string;
	};
	if (payload.error) {
		throw new Error(`dispatch relay upstream error: ${payload.error}`);
	}
	markRelayResult(0, payload.tookNs / 1_000_000);
	return {
		status: payload.status,
		headers: payload.headers,
		body: new Uint8Array(Buffer.from(payload.bodyBase64, "base64")),
		tookMs,
		upstreamMs: payload.tookNs / 1_000_000,
		goPrepMs: 0,
	};
}

async function dispatchBinaryHttp(
	config: DispatchConfig,
	req: { method: string; url: string; headers: Record<string, string>; body: Uint8Array; signal?: AbortSignal },
): Promise<DispatchResult> {
	const url = new URL(config.url);
	url.pathname = "/dispatch-bin";
	const encodeStart = performance.now();
	const wireBody = encodeDispatchRequest(req);
	markRelayDispatch(performance.now() - encodeStart);
	const start = performance.now();
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/octet-stream",
			"x-dispatch-token": config.token,
		},
		body: wireBody.buffer as ArrayBuffer,
		signal: req.signal,
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`binary dispatch relay error: HTTP ${res.status} ${text}`);
	}
	const payload = decodeDispatchResponse(new Uint8Array(await res.arrayBuffer()));
	markRelayResult(payload.goPrepMs, payload.upstreamMs);
	return {
		status: payload.status,
		headers: payload.headers,
		body: payload.body,
		tookMs: performance.now() - start,
		upstreamMs: payload.upstreamMs,
		goPrepMs: payload.goPrepMs,
	};
}

/** Binary is the production default; JSON remains an operational rollback. */
export function dispatchHttp(
	config: DispatchConfig,
	req: { method: string; url: string; headers: Record<string, string>; body: Uint8Array; signal?: AbortSignal },
): Promise<DispatchResult> {
	return process.env.DISPATCH_BINARY === "0"
		? dispatchJsonHttp(config, req)
		: dispatchBinaryHttp(config, req);
}

// LINE's push/receive stream (long-lived half-duplex POST) can't be
// modeled as a single buffered request/response — it must keep using the
// platform's native fetch untouched. Every other RPC (login, sync,
// sendMessage, react, ...) is a plain one-shot POST and is safe to relay
// through Go.
const PUSH_STREAM_PATH = "/PUSH/1/subs";

async function fetchLineDirect(
	info: RequestInfo | URL,
	init?: RequestInit,
	prewarmBody?: Uint8Array,
): Promise<Response> {
	// The Request is already fully encoded by linejs. Sending it from Bun
	// avoids a second HTTP hop and a Windows process-context switch.
	markRelayDispatch(0);
	const upstreamStart = performance.now();
	if (prewarmBody) {
		markRelayResult(0, 0);
		return attachRawDispatchBody(new Response(prewarmBody as BodyInit), prewarmBody);
	}
	try {
		// Prefer a connection this process owns and can vet, so a send never
		// has to ride whichever pooled connection Bun happens to hand back —
		// including one LINE has just told us it is closing. Returns
		// undefined when no lane is healthy, which keeps Bun's pool as the
		// fallback rather than a failure.
		const laneResponse = await distributedLaneFetch(info, init);
		if (laneResponse) {
			markRelayResult(0, performance.now() - upstreamStart);
			return laneResponse;
		}
		const response = await globalThis.fetch(info, init);
		const body = new Uint8Array(await response.arrayBuffer());
		markRelayResult(0, performance.now() - upstreamStart);
		return attachRawDispatchBody(response, body);
	} catch (error) {
		markRelayResult(0, performance.now() - upstreamStart);
		throw error;
	}
}

/**
 * Builds a linejs `FetchLike` that routes one-shot RPCs through the Go
 * dispatch relay while leaving the push stream on native fetch. Passed as
 * `ClientInit.fetch` when constructing the vendored BaseClient — this is
 * the library's own supported extension point, not a monkey-patch.
 */
export function createDispatchFetch(config: DispatchConfig): FetchLike {
	const dispatchFetch: FetchLike = async (request: Request): Promise<Response> => {
		if (request.url.includes(PUSH_STREAM_PATH)) {
			return globalThis.fetch(request);
		}
		const transport = process.env.LINE_TRANSPORT ?? "hybrid";
		const pathname = new URL(request.url).pathname;
		const compactTalk = pathname === "/CA5" || pathname === "/ECA5";
		// Login/control stays on the proven Go pool. Only compact Talk bypasses
		// loopback by default. (A "fast-ACK Square sends bypass too" path was
		// half-wired here via markDirectLineRequest/isDirectLineRequest, but
		// nothing ever called the marker — the condition could never be true —
		// so it was removed as dead code rather than kept half-built. Square
		// sends already measure close to the documented warm baseline through
		// the Go relay; revisit only if that stops being true.)
		if (transport === "direct" || (transport !== "go" && compactTalk)) {
			return fetchLineDirect(request);
		}

		const bodyBuf = request.body ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array(0);
		const headers: Record<string, string> = {};
		request.headers.forEach((value, key) => {
			headers[key] = value;
		});

		const result = await dispatchHttp(config, {
			method: request.method,
			url: request.url,
			headers,
			body: bodyBuf,
			signal: request.signal,
		});

		const responseHeaders = new Headers();
		for (const [key, values] of Object.entries(result.headers)) {
			for (const value of values) responseHeaders.append(key, value);
		}
		return attachRawDispatchBody(
			new Response(result.body as BodyInit, { status: result.status, headers: responseHeaders }),
			result.body,
		);
	};
	return attachHotLineFetch(dispatchFetch, (info, init) => {
		// Explicit operational rollback retains the Go relay semantics.
		if (process.env.LINE_TRANSPORT === "go") {
			return Promise.resolve(dispatchFetch(new Request(info, init)));
		}
		return fetchLineDirect(info, init);
	}, (info, init) => {
		const body = String(info).includes("/SQ1")
			? PREWARM_SQUARE_ACK
			: PREWARM_TALK_ACK;
		return fetchLineDirect(info, init, body);
	});
}
