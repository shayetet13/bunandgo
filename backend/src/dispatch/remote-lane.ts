/**
 * A second physical machine's h2-lanes pool (server3, the lane-relay box —
 * see backend/src/relay/) folded into this process's own lane candidates as
 * one more entry, ranked by the exact same hot/warm/fallback tiering
 * `sendCandidatesWithCrossover`/`selectPollingLaneCandidate` already apply
 * to local lanes. It never adds a network round trip to a routing decision:
 * its RTT is kept warm in the background from the relay's own periodic
 * report (`updateRemoteLaneFromReport`, called by lane-relay-events.ts) and
 * from this process's own real dispatch outcomes, exactly like a local
 * lane's PING and application-RTT samples.
 */

/** Well above any real local lane id (0..31, see h2-lanes.ts's 32-lane cap)
 * so the two id spaces can never collide when merged into one array. */
export const REMOTE_LANE_ID = 900;

/** How stale the relay's last self-report can be before its RTT is no
 * longer trusted as "current" — a few multiples of its own ~5s report
 * interval, generous enough to absorb one missed push. */
const REPORT_STALE_MS = Math.max(3_000, Number(process.env.LINE_RELAY_STALE_MS ?? 3_000));
const APPLICATION_SAMPLE_MAX_AGE_MS = Math.max(1_000, Number(process.env.LINE_H2_APPLICATION_SAMPLE_MAX_AGE_MS ?? 30_000));

export interface RemoteLaneMetrics {
	readonly id: number;
	inFlight: number;
	lastOkAt: number;
	rttMs?: number;
	sendRttMs?: number;
	sendNetworkRttMs?: number;
	pollRttMs?: number;
	lastSendOkAt: number;
	lastPollOkAt: number;
	pollApplicationSamples: number;
	consecutiveSlowApplicationSamples: number;
}

interface RemoteOriginState {
	metrics: RemoteLaneMetrics;
	/** Best RTT server3 itself last reported having to this origin, and when —
	 * the fallback signal before this process has any real measurement of its
	 * own through the relay yet. */
	reportedBestRttMs?: number;
	reportedApplication: boolean;
	reportedAt: number;
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
				pollApplicationSamples: 0,
				consecutiveSlowApplicationSamples: 0,
			},
			reportedApplication: false,
			reportedAt: 0,
		};
		origins.set(origin, state);
	}
	return state;
}

/** Called by lane-relay-events.ts whenever the relay's own periodic report
 * is accepted — keeps a background RTT estimate warm without this process
 * ever polling the relay itself. */
export function updateRemoteLaneFromReport(origin: string, bestRttMs: number | undefined, now: number, reportedApplication = true): void {
	const state = ensureOrigin(origin);
	state.reportedBestRttMs = bestRttMs;
	state.reportedApplication = reportedApplication;
	state.reportedAt = now;
}

/**
 * The remote candidate for `origin`, or undefined when the relay isn't
 * configured or has nothing recent enough to trust — callers append the
 * result to their local `usable` array before ranking, never replace it.
 */
export function remoteLaneCandidate(origin: string, now: number = Date.now()): RemoteLaneMetrics | undefined {
	if (!remoteDispatchConfig()) return undefined;
	const state = origins.get(origin);
	if (!state) return undefined;
	// A real measurement from this process's own dispatches always wins over
	// the relay's self-report; the self-report only fills in before the first
	// real send/poll has gone through it.
	const ownSampleAt = Math.max(state.metrics.lastSendOkAt, state.metrics.lastPollOkAt);
	if (ownSampleAt > 0 && now - ownSampleAt <= APPLICATION_SAMPLE_MAX_AGE_MS) return state.metrics;
	if (state.reportedBestRttMs === undefined || now - state.reportedAt > REPORT_STALE_MS) return undefined;
	return {
		...state.metrics,
		rttMs: state.reportedBestRttMs,
		sendRttMs: state.reportedApplication ? state.reportedBestRttMs : undefined,
		pollRttMs: undefined,
		lastSendOkAt: state.reportedApplication ? state.reportedAt : 0,
		lastPollOkAt: 0,
		lastOkAt: Math.max(state.metrics.lastOkAt, state.reportedAt),
	};
}

export function recordRemoteDispatchStart(origin: string): void {
	ensureOrigin(origin).metrics.inFlight++;
}

/**
 * Mirrors h2-lanes.ts's own recordApplicationRtt EWMA so the remote lane's
 * score decays/recovers on the same footing as every local one — a fresh
 * outlier must not permanently poison it, and repeated real slowness must
 * still show up as unmistakably slow.
 */
export function recordRemoteDispatchEnd(
	origin: string,
	role: "send" | "poll" | undefined,
	elapsedMs: number,
	discardCeilingMs: number,
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
	m.consecutiveSlowApplicationSamples = elapsedMs >= discardCeilingMs ? m.consecutiveSlowApplicationSamples + 1 : 0;
	if (role === "poll") {
		// Match local poll routing: the latest end-to-end relay result decides
		// whether Server 3 remains below the active ceiling.
		m.pollRttMs = elapsedMs;
		m.pollApplicationSamples++;
		m.lastPollOkAt = now;
	} else {
		m.sendRttMs = m.sendRttMs === undefined ? elapsedMs : m.sendRttMs * 0.65 + elapsedMs * 0.35;
		m.lastSendOkAt = now;
	}
	m.lastOkAt = now;
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
