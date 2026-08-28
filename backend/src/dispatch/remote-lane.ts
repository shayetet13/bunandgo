/**
 * A second physical machine's h2-lanes pool (server3, the lane-relay box —
 * see backend/src/relay/) folded into this process's own lane candidates as
 * one more entry, ranked by the same role-specific robust score that local
 * lanes use. It never adds a network round trip to a routing decision:
 * its RTT is kept warm in the background from the relay's own periodic
 * report (`updateRemoteLaneFromReport`, called by lane-relay-events.ts) and
 * from this process's own real dispatch outcomes, exactly like a local
 * lane's PING, SEND and POLL samples without mixing their roles.
 */

import { nextSendSlowUntil, SEND_SLOW_THRESHOLD_MS } from "./lane-speed-policy.ts";
import {
	freshSendRouteProfile,
	getOrCreateSendRouteProfile,
	percentile,
	recordSendRouteSample,
	SEND_ROUTE_SAMPLE_MAX_AGE_MS,
	SEND_SAMPLE_WINDOW,
	type SendRouteProfile,
} from "./send-prediction.ts";

/** Well above any real local lane id (0..31, see h2-lanes.ts's 32-lane cap)
 * so the two id spaces can never collide when merged into one array. */
export const REMOTE_LANE_ID = 900;

/** How stale the relay's last self-report can be before its RTT is no
 * longer trusted as "current" — a few multiples of its own ~5s report
 * interval, generous enough to absorb one missed push. */
const REPORT_STALE_MS = Math.max(3_000, Number(process.env.LINE_RELAY_STALE_MS ?? 3_000));
/**
 * 15 minutes, matching send-prediction's route window. Production SEND traffic
 * to one origin is minutes apart, so the old 30s made the relay's own
 * end-to-end samples expire before the next real send and it fell back to its
 * self-reported PING forever — the same starvation the local lanes had.
 */
const APPLICATION_SAMPLE_MAX_AGE_MS = Math.max(1_000, Number(process.env.LINE_H2_APPLICATION_SAMPLE_MAX_AGE_MS ?? 900_000));

export interface RemoteLaneMetrics {
	readonly id: number;
	inFlight: number;
	lastOkAt: number;
	rttMs?: number;
	sendRttMs?: number;
	pollRttMs?: number;
	lastSendOkAt: number;
	lastPollOkAt: number;
	sendSlowUntil: number;
	pollApplicationSamples: number;
	sendRttSamples?: readonly number[];
	sendRouteProfiles?: ReadonlyMap<string, SendRouteProfile>;
	streamCapacity?: number;
}

interface RemoteOriginState {
	metrics: RemoteLaneMetrics;
	/** Role-specific samples measured by this process across the full S2→S3→LINE path. */
	sendSamples: number[];
	pollSamples: number[];
	sendRouteProfiles: Map<string, SendRouteProfile>;
	/** Server3 self-report is a bootstrap only; own end-to-end samples win. */
	reportedPingRttMs?: number;
	reportedSendRttMs?: number;
	reportedPollRttMs?: number;
	reportedSendSampleAt: number;
	reportedPollSampleAt: number;
	reportedAt: number;
}

export interface RemoteLaneReport {
	pingRttMs?: number;
	sendRttMs?: number;
	pollRttMs?: number;
	sendSampleAt?: number;
	pollSampleAt?: number;
}

const APPLICATION_RTT_WINDOW = SEND_SAMPLE_WINDOW;

function recordMedian(samples: number[], sampleMs: number): number {
	samples.push(sampleMs);
	if (samples.length > APPLICATION_RTT_WINDOW) samples.shift();
	const sorted = [...samples].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)]!;
}

const origins = new Map<string, RemoteOriginState>();

// Read fresh on every call rather than cached at module load — matches
// readWorkerTopology()'s convention so tests can set/change the env vars
// without fighting Bun's module cache, and so a config change only ever
// needs the same restart a code change would (no extra staleness to reason
// about on top of that).
export function remoteDispatchConfig(): { url: string; token: string } | undefined {
	const url = process.env.LINE_RELAY_URL?.trim();
	const token = process.env.LINE_RELAY_TOKEN?.trim();
	if (!url || !token) return undefined;
	return { url, token };
}

export function isRemoteLaneId(id: number): boolean {
	return id === REMOTE_LANE_ID;
}

function ensureOrigin(origin: string): RemoteOriginState {
	let state = origins.get(origin);
	if (!state) {
		state = {
			metrics: {
				id: REMOTE_LANE_ID,
				inFlight: 0,
				lastOkAt: 0,
				lastSendOkAt: 0,
				lastPollOkAt: 0,
				sendSlowUntil: 0,
				pollApplicationSamples: 0,
			},
			sendSamples: [],
			pollSamples: [],
			sendRouteProfiles: new Map(),
			reportedSendSampleAt: 0,
			reportedPollSampleAt: 0,
			reportedAt: 0,
		};
		origins.set(origin, state);
	}
	return state;
}

/** Called by lane-relay-events.ts whenever the relay's own periodic report
 * is accepted — keeps a background RTT estimate warm without this process
 * ever polling the relay itself. */
export function updateRemoteLaneFromReport(origin: string, report: RemoteLaneReport, now: number): void {
	const state = ensureOrigin(origin);
	state.reportedPingRttMs = report.pingRttMs;
	state.reportedSendRttMs = report.sendRttMs;
	state.reportedPollRttMs = report.pollRttMs;
	state.reportedSendSampleAt = report.sendSampleAt ?? 0;
	state.reportedPollSampleAt = report.pollSampleAt ?? 0;
	state.reportedAt = now;
}

/**
 * The remote candidate for `origin`, or undefined when the relay isn't
 * configured or has nothing recent enough to trust — callers append the
 * result to their local `usable` array before ranking, never replace it.
 */
export function remoteLaneCandidate(origin: string, now: number = Date.now(), routeKey?: string): RemoteLaneMetrics | undefined {
	if (!remoteDispatchConfig()) return undefined;
	const state = origins.get(origin);
	if (!state) return undefined;
	const reportFresh = now - state.reportedAt <= REPORT_STALE_MS;
	const ownSendFresh = state.metrics.lastSendOkAt > 0 && now - state.metrics.lastSendOkAt <= APPLICATION_SAMPLE_MAX_AGE_MS;
	const routeProfile = freshSendRouteProfile(state.sendRouteProfiles, routeKey, now);
	const ownPollFresh = state.metrics.lastPollOkAt > 0 && now - state.metrics.lastPollOkAt <= APPLICATION_SAMPLE_MAX_AGE_MS;
	if (!reportFresh && !ownSendFresh && !ownPollFresh && !routeProfile) return undefined;
	const reportedSendFresh =
		reportFresh && state.reportedSendSampleAt > 0 && now - state.reportedSendSampleAt <= APPLICATION_SAMPLE_MAX_AGE_MS;
	const reportedPollFresh =
		reportFresh && state.reportedPollSampleAt > 0 && now - state.reportedPollSampleAt <= APPLICATION_SAMPLE_MAX_AGE_MS;
	const routeRttMs = percentile(routeProfile?.samples ?? [], 0.5);
	const sendRttMs = routeRttMs ?? (ownSendFresh ? state.metrics.sendRttMs : reportedSendFresh ? state.reportedSendRttMs : undefined);
	const pollRttMs = ownPollFresh ? state.metrics.pollRttMs : reportedPollFresh ? state.reportedPollRttMs : undefined;
	if ((!reportFresh || state.reportedPingRttMs === undefined) && sendRttMs === undefined && pollRttMs === undefined) return undefined;
	return {
		...state.metrics,
		sendRttSamples: routeProfile?.samples ?? (ownSendFresh ? state.sendSamples : undefined),
		sendRouteProfiles: state.sendRouteProfiles,
		rttMs: reportFresh ? state.reportedPingRttMs : undefined,
		sendRttMs,
		pollRttMs,
		sendSlowUntil: routeKey
			? (routeProfile?.slowUntil ?? 0)
			: ownSendFresh
				? state.metrics.sendSlowUntil
				: reportedSendFresh && state.reportedSendRttMs !== undefined
					? nextSendSlowUntil(state.reportedSendRttMs, state.reportedSendSampleAt)
					: 0,
		lastSendOkAt: routeProfile?.lastAt ?? (ownSendFresh ? state.metrics.lastSendOkAt : reportedSendFresh ? state.reportedSendSampleAt : 0),
		lastPollOkAt: ownPollFresh ? state.metrics.lastPollOkAt : reportedPollFresh ? state.reportedPollSampleAt : 0,
		lastOkAt: Math.max(state.metrics.lastOkAt, state.reportedAt),
	};
}

export function recordRemoteDispatchStart(origin: string, _routeKey?: string): void {
	ensureOrigin(origin).metrics.inFlight++;
}

/**
 * True while the relay is reachable and self-reporting but this worker has no
 * fresh end-to-end **SEND** sample for it. SEND selection needs a real SEND
 * result to ever prefer the relay (`shouldPreferRemoteLane`, role "send"), and
 * POLL overflow reaches the relay on its own, so a live POLL sample must NOT
 * suppress the SEND bootstrap — in production the relay always has fresh POLL
 * traffic, which is exactly why the earlier version never fired. `laneFetch`
 * routes a bounded share of live sends here until that first SEND sample lands,
 * then score-based selection takes over.
 */
export function remoteLaneNeedsBootstrap(origin: string, now: number = Date.now()): boolean {
	if (!remoteDispatchConfig()) return false;
	const state = origins.get(origin);
	if (!state) return false;
	if (now - state.reportedAt > REPORT_STALE_MS || state.reportedPingRttMs === undefined) return false;
	const fresh = (at: number, maxAge: number): boolean => at > 0 && now - at <= maxAge;
	if (fresh(state.metrics.lastSendOkAt, APPLICATION_SAMPLE_MAX_AGE_MS)) return false;
	if (fresh(state.reportedSendSampleAt, APPLICATION_SAMPLE_MAX_AGE_MS)) return false;
	for (const profile of state.sendRouteProfiles.values()) {
		if (fresh(profile.lastAt, SEND_ROUTE_SAMPLE_MAX_AGE_MS)) return false;
	}
	return true;
}

/** Mirrors h2-lanes.ts's role-specific median-of-three route score. */
export function recordRemoteDispatchEnd(
	origin: string,
	role: "send" | "poll" | undefined,
	elapsedMs: number,
	routeKey?: string,
	slowThresholdMs: number = SEND_SLOW_THRESHOLD_MS,
): void {
	const state = ensureOrigin(origin);
	const m = state.metrics;
	m.inFlight = Math.max(0, m.inFlight - 1);
	if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
	const now = Date.now();
	if (role === undefined) {
		m.lastOkAt = now;
		return;
	}
	if (role === "poll") {
		m.pollRttMs = recordMedian(state.pollSamples, elapsedMs);
		m.pollApplicationSamples++;
		m.lastPollOkAt = now;
	} else {
		m.sendRttMs = recordMedian(state.sendSamples, elapsedMs);
		m.sendRttSamples = state.sendSamples;
		m.lastSendOkAt = now;
		m.sendSlowUntil = nextSendSlowUntil(Math.max(elapsedMs, m.sendRttMs), now, slowThresholdMs);
		if (routeKey) recordSendRouteSample(getOrCreateSendRouteProfile(state.sendRouteProfiles, routeKey), elapsedMs, now, slowThresholdMs);
	}
	m.lastOkAt = now;
}

/** Releases concurrency state without poisoning routing with a failed or
 * ambiguous dispatch duration. */
export function recordRemoteDispatchFailure(origin: string): void {
	const m = ensureOrigin(origin).metrics;
	m.inFlight = Math.max(0, m.inFlight - 1);
}

/** Test-only reset. */
export function resetRemoteLaneStateForTest(): void {
	origins.clear();
}

// ---- Wire protocol to the relay's /dispatch endpoint -----------------------
// Shared by every production request that the worker pins to server3.

function headersToRecord(source: RequestInit["headers"]): Record<string, string> {
	const headers: Record<string, string> = {};
	if (!source) return headers;
	if (source instanceof Headers) {
		source.forEach((value, key) => {
			headers[key] = value;
		});
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
 * Executes one request through a lane-relay box's /dispatch endpoint.
 * Mirrors laneFetch()'s own contract precisely, including its two-outcome
 * shape: resolves `undefined` only when the relay itself could never be
 * reached (a network failure connecting to server3) — nothing left this
 * process, so a caller falling back to a local lane or plain fetch cannot
 * double-send. Once the relay has accepted the request, every failure after
 * that point rejects instead: whether *it* reached LINE is now unknown, and
 * a caller must never retry blindly on that basis (same reasoning
 * h2-lanes.ts documents for its own local sends).
 */
export async function dispatchViaRelay(
	config: { url: string; token: string },
	info: RequestInfo | URL,
	init: RequestInit | undefined,
	role: "send" | "poll" | "warm" | undefined,
): Promise<Response | undefined> {
	const url = info instanceof URL ? info : new URL(typeof info === "string" ? info : info.url);
	let response: Response;
	try {
		response = await fetch(config.url, {
			method: "POST",
			headers: { "content-type": "application/json", "x-lane-relay-token": config.token },
			body: JSON.stringify({
				method: init?.method ?? "GET",
				url: url.toString(),
				headers: headersToRecord(init?.headers),
				bodyBase64: await bodyToBase64(init?.body as BodyInit | null | undefined),
				role,
			}),
			signal: AbortSignal.timeout(20_000),
		});
	} catch {
		// Never reached the relay box at all — nothing was sent anywhere.
		return undefined;
	}
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`lane relay dispatch failed: HTTP ${response.status} ${text}`);
	}
	const payload = (await response.json()) as {
		status: number;
		headers: Record<string, string>;
		bodyBase64: string;
		error?: string;
	};
	if (payload.error) throw new Error(`lane relay upstream error: ${payload.error}`);
	return new Response(new Uint8Array(Buffer.from(payload.bodyBase64, "base64")) as BodyInit, {
		status: payload.status,
		headers: payload.headers,
	});
}
