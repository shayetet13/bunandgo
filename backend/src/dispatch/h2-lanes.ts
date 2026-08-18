import { connect as connectHttp2, constants, type ClientHttp2Session, type ClientHttp2Stream, type OutgoingHttpHeaders } from "node:http2";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { attachRawDispatchBody } from "./raw-response.ts";
import { recordLaneRace, shouldScorePollLane } from "./lane-race.ts";

/**
 * A small pool of HTTP/2 connections ("lanes") to a LINE host that this
 * process owns outright, instead of leaving connection choice to Bun's
 * global fetch pool.
 *
 * Why this exists: a reply is a single tiny request, so extra connections
 * buy no parallelism at all. What they buy is *choice*. With one pooled
 * connection, a send that lands right after LINE sends GOAWAY, or on a
 * connection whose path just lost a packet, pays that connection's problem
 * in full — and Bun's `fetch` gives no way to say "not that one". With two
 * lanes we keep a proven-warm primary and a hot standby, and pick at send
 * time.
 *
 * Deliberately NOT hedging: exactly one lane carries each send, so a
 * message can never be delivered twice. Poll traffic rotates to keep every
 * candidate application-warm; send traffic retains soft affinity until a
 * materially better or less-loaded lane is available.
 *
 * `LINE_H2_LANES=0` falls straight back to `globalThis.fetch`.
 */

// Polling keeps the application side of each connection hot while sends need
// enough alternatives to escape a stream that has just become slow. Six is a
// deliberate small pool: large enough to absorb several concurrent bot
// sessions without turning every account into its own connection pool.
const LANE_COUNT = Math.max(0, Number(process.env.LINE_H2_LANES ?? 6));

/**
 * How many low-numbered lanes carry sends only, with poll traffic kept off
 * them entirely.
 *
 * Polling and sending share one pool, and `pickPollingLane` rotates across
 * every lane — so a continuous poller leaves an in-flight stream on most of
 * them, and `IN_FLIGHT_PENALTY_MS` then scores whatever is left as worse.
 * That is the mechanism behind the `SQUARE_FAST_POLL_WORKERS=2` result
 * recorded in `bot/fast-square-poller.ts`: eight continuous polls over six
 * lanes left a reply no uncontended route, and `upstream` went 16.6ms ->
 * 35.5ms. Reserving a lane is the deeper version of that fix — it lets poll
 * concurrency rise to cut inbound delay without the reply paying for it.
 *
 * Defaults to 0 (every lane shared, exactly the previous behaviour) because
 * the benefit is unmeasured: two earlier attempts to tune this path both
 * regressed, and reply latency on identical code varies from 18ms to 80ms,
 * which is more than enough to manufacture a convincing result. Turn it on
 * only behind interleaved A/B samples — see `scripts/ab-latency.sh`.
 *
 * Clamped to leave at least one lane for polling, and the reservation is
 * only ever a preference: if every reserved lane is down a send still uses
 * whatever is usable rather than failing.
 */
const SEND_RESERVED_LANES = Math.min(
	Math.max(0, Number(process.env.LINE_H2_SEND_RESERVED_LANES ?? 0)),
	Math.max(0, LANE_COUNT - 1),
);

/**
 * Frequent enough that a broken path is discovered long before a message
 * needs it, sparse enough to look like the keepalive traffic any connected
 * LINE client produces. An h2 PING is 8 bytes and never reaches LINE's
 * application layer.
 */
const PING_INTERVAL_MS = 15_000;

/**
 * A connection can remain technically healthy while the Akamai route behind
 * it slowly gets worse. PING only proves that the socket is alive; it cannot
 * move that socket to a newly preferred edge/IP. Rolling one idle lane at a
 * time gives DNS/routing another chance without restarting every bot or
 * interrupting an in-flight send.
 *
 * Zero disables age-based recycling. The one-minute floor prevents an env
 * typo from turning this into a reconnect loop.
 */
function recycleInterval(raw: string | undefined, fallback: number): number {
	const value = Number(raw ?? fallback);
	if (!Number.isFinite(value) || value < 0) return fallback;
	return value === 0 ? 0 : Math.max(60_000, value);
}

const LANE_MAX_AGE_MS = recycleInterval(
	process.env.LINE_H2_LANE_MAX_AGE_MS,
	15 * 60_000,
);
const LANE_RECYCLE_MIN_GAP_MS = recycleInterval(
	process.env.LINE_H2_LANE_RECYCLE_GAP_MS,
	60_000,
);

/** A recent real LINE request, not edge-only H2 PING, gates hot routing. */
const APPLICATION_HOT_CEILING_MS = Math.max(
	0,
	Number(
		process.env.LINE_H2_APPLICATION_HOT_CEILING_MS ??
		process.env.LINE_H2_APPLICATION_LANE_CEILING_MS ??
		20,
	),
);
/** Known routes at or above this RTT are removed from foreground sends. */
const APPLICATION_DISCARD_CEILING_MS = Math.max(
	APPLICATION_HOT_CEILING_MS,
	Number(process.env.LINE_H2_APPLICATION_DISCARD_CEILING_MS ?? 23),
);
const APPLICATION_SAMPLE_MAX_AGE_MS = Math.max(
	1_000,
	Number(process.env.LINE_H2_APPLICATION_SAMPLE_MAX_AGE_MS ?? 30_000),
);
const DEGRADED_REPAIR_MIN_GAP_MS = Math.max(
	60_000,
	Number(process.env.LINE_H2_DEGRADED_REPAIR_GAP_MS ?? 60_000),
);
const DEGRADED_REPAIR_MIN_SAMPLES = Math.max(
	1,
	Math.floor(Number(process.env.LINE_H2_DEGRADED_REPAIR_MIN_SAMPLES ?? 3)),
);
const POLL_LANE_CALIBRATION_SAMPLES = Math.max(
	1,
	Math.floor(Number(process.env.LINE_H2_POLL_CALIBRATION_SAMPLES ?? 3)),
);

const CONNECT_TIMEOUT_MS = 10_000;
/** Backoff ceiling for a host that is refusing connections outright. */
const RECONNECT_MAX_DELAY_MS = 8_000;

type LaneState = "connecting" | "ready" | "draining" | "dead";
type LaneRole = "send" | "poll" | undefined;

/** Process-local routing hint. It is stripped before anything reaches LINE. */
export const H2_LANE_ROLE_HEADER = "x-linebot-h2-role";

interface Lane {
	readonly id: number;
	/** Scheme + host + port, e.g. `https://legy.line-apps.com`. */
	readonly origin: string;
	/** Value for `:authority` — host and, when non-default, port. */
	readonly authority: string;
	state: LaneState;
	session?: ClientHttp2Session;
	inFlight: number;
	lastOkAt: number;
	/** Smoothed HTTP/2 PING round trip for choosing between warm routes. */
	rttMs?: number;
	/** Smoothed real application round trips, kept separate by workload. */
	sendRttMs?: number;
	/** Network PING baseline captured with the latest send RTT sample. */
	sendNetworkRttMs?: number;
	pollRttMs?: number;
	lastSendOkAt: number;
	lastPollOkAt: number;
	pollApplicationSamples: number;
	consecutiveFailures: number;
	consecutiveSlowApplicationSamples: number;
	/** Wall-clock time this physical HTTP/2 session connected. */
	openedAt: number;
	reconnectTimer?: ReturnType<typeof setTimeout>;
	/**
	 * Set by `stopLanes`. A reconnect already in flight when the pool is torn
	 * down would otherwise fail, schedule its own successor, and keep an
	 * orphaned retry loop running against a lane nothing can reach.
	 */
	disposed: boolean;
}

export interface LaneStat {
	origin: string;
	id: number;
	state: LaneState;
	inFlight: number;
	lastOkAt: number;
	rttMs?: number;
	sendRttMs?: number;
	pollRttMs?: number;
	lastSendOkAt: number;
	lastPollOkAt: number;
	/** Freshest real send/poll RTT — the same value used by hot routing. */
	applicationRttMs?: number;
	applicationSampleAt: number;
	routingEligible: boolean;
	consecutiveFailures: number;
	openedAt: number;
}

const pools = new Map<string, Lane[]>();
/**
 * Latest TLS session ticket per origin, so a reconnect can resume instead of
 * paying a full handshake. `node:http2`/`node:tls` has no built-in cache the
 * way Go's `tls.Config.ClientSessionCache` does — this is the documented
 * manual pattern: capture the socket's `session` event and hand the ticket
 * back in on the next `connect()` for that origin. TLS 1.3 can emit more
 * than one ticket per connection; last-write-wins is correct since only the
 * freshest ticket is ever useful.
 */
const sessionTickets = new Map<string, Buffer>();
/** Soft send affinity, re-evaluated against real application RTT every send. */
const preferredSendLaneIds = new Map<string, number>();
/** Last polling lane per origin. The next poll advances from here. */
const pollCursorIds = new Map<string, number>();
/** Last deliberate standby application probe per origin. */
const lastPollExploreAt = new Map<string, number>();
/** Last rolling lane replacement per origin; keeps replacements staggered. */
const lastLaneRecycleAt = new Map<string, number>();
/** Background-only repair throttle; never awaited by a reply. */
const lastDegradedRepairAt = new Map<string, number>();
let pingTimer: ReturnType<typeof setInterval> | undefined;

// Fast polling supplies enough real traffic to rank application paths, but
// pinning forever to yesterday's winner would never discover a recovered
// standby. The interval is configurable so a wider pool still refreshes every
// route inside the application-sample freshness window.
const POLL_LANE_EXPLORE_INTERVAL_MS = Math.max(
	1_000,
	Number(process.env.LINE_H2_POLL_EXPLORE_INTERVAL_MS ?? 5_000),
);
const LOG_POLL_LANE_EXPLORATION = process.env.LINE_H2_LOG_POLL_EXPLORE === "1";

function isUsable(lane: Lane): boolean {
	const session = lane.session;
	return lane.state === "ready" && session !== undefined && !session.destroyed && !session.closed;
}

/** Reads the process-local role hint without forwarding it to LINE. */
function headerValue(init: RequestInit | undefined, wanted: string): string | undefined {
	const source = init?.headers;
	if (!source) return undefined;
	if (source instanceof Headers) return source.get(wanted) ?? undefined;
	if (Array.isArray(source)) {
		return source.find(([key]) => key.toLowerCase() === wanted)?.[1];
	}
	for (const [key, value] of Object.entries(source)) {
		if (key.toLowerCase() === wanted && value !== undefined) return String(value);
	}
	return undefined;
}

function requestRole(init: RequestInit | undefined): LaneRole {
	const value = headerValue(init, H2_LANE_ROLE_HEADER);
	return value === "send" || value === "poll" ? value : undefined;
}

/**
 * The usable lanes a role should choose between.
 *
 * With a reservation configured, sends look at the reserved lanes and polls
 * look at the rest. Either set falling empty — every reserved lane dead, or
 * every unreserved one — widens the choice back to all usable lanes: the
 * reservation exists to keep the two workloads off each other, never to
 * fail a request that some connection could still carry.
 */
export function laneCandidates<T extends { id: number }>(
	usable: T[],
	role: LaneRole,
	reserved: number = SEND_RESERVED_LANES,
): T[] {
	if (reserved === 0 || role === undefined || usable.length === 0) return usable;
	const preferred = usable.filter((lane) =>
		role === "send" ? lane.id < reserved : lane.id >= reserved
	);
	return preferred.length > 0 ? preferred : usable;
}

function pickPollingLane(lanes: Lane[]): Lane | undefined {
	const usable = laneCandidates(lanes.filter(isUsable), "poll");
	if (usable.length === 0) return undefined;
	const origin = usable[0]!.origin;
	const minInFlight = Math.min(...usable.map((lane) => lane.inFlight));
	const candidates = usable.filter((lane) => lane.inFlight === minInFlight).sort((a, b) => a.id - b.id);
	// Calibrate every available application path before trusting the winner.
	// H2 PING reaches the Akamai edge, while poll RTT also includes LINE's
	// request path; the latter is the number this workload actually races on.
	const cursor = pollCursorIds.get(origin) ?? -1;
	const now = Date.now();
	const explore = now - (lastPollExploreAt.get(origin) ?? 0) >= POLL_LANE_EXPLORE_INTERVAL_MS;
	const next = selectPollingLaneCandidate(candidates, cursor, explore)!;
	if (explore && candidates.every((lane) => lane.pollRttMs !== undefined)) {
		lastPollExploreAt.set(origin, now);
		// Diagnostic only, logged only on the case that can actually hurt: an
		// explore round handed this poll a lane measurably worse than the best
		// one available. Silent when explore happens to land on the best lane
		// anyway, so this stays rare instead of firing every 5s regardless.
		const bestRtt = Math.min(...candidates.map((lane) => lane.pollRttMs!));
		if (
			LOG_POLL_LANE_EXPLORATION && next.pollRttMs !== undefined &&
			next.pollRttMs - bestRtt > RTT_SWITCH_MARGIN_MS
		) {
			console.log(
				`[h2-lanes] poll explore: lane ${next.id} rtt=${next.pollRttMs.toFixed(1)}ms ` +
					`vs best available rtt=${bestRtt.toFixed(1)}ms (origin=${origin})`,
			);
		}
	}
	pollCursorIds.set(origin, next.id);
	return next;
}

function pickLane(lanes: Lane[], role: LaneRole): Lane | undefined {
	if (role === "poll") return pickPollingLane(lanes);
	const origin = lanes[0]?.origin;
	const usable = lanes.filter(isUsable);
	const candidates = role === "send"
		? sendCandidatesWithCrossover(usable)
		: laneCandidates(usable, role);

	let best: Lane | undefined;
	for (const lane of candidates) {
		if (
			best === undefined ||
			(role === "send" ? shouldPreferFastestSendLane(lane, best, 0) : isBetterLane(lane, best, role))
		) {
			best = lane;
		}
	}
	if (!best || origin === undefined) return best;

	const preferredId = preferredSendLaneIds.get(origin);
	// Looked up among the candidates, not every lane: when a reservation is
	// in force, affinity held from before must not pin sends to a poll lane.
	const preferred = preferredId === undefined
		? undefined
		: candidates.find((lane) => lane.id === preferredId);
	if (!preferred && preferredId !== undefined) preferredSendLaneIds.delete(origin);

	// Soft affinity preserves the application-warm connection while still
	// allowing a materially faster or less-loaded lane to take over. A global
	// hard pin made six physical sessions behave like one until it died.
	const selected = preferred && !shouldPreferFastestSendLane(best, preferred) ? preferred : best;
	preferredSendLaneIds.set(origin, selected.id);
	return selected;
}

// Route differences below this are noise; retain the old freshness/load
// preference instead of bouncing streams between effectively equal paths.
const RTT_SWITCH_MARGIN_MS = Math.max(0, Number(process.env.LINE_H2_RTT_SWITCH_MARGIN_MS ?? 0.75));

interface LaneChoiceMetrics {
	rttMs?: number;
	sendRttMs?: number;
	sendNetworkRttMs?: number;
	pollRttMs?: number;
	lastSendOkAt?: number;
	lastPollOkAt?: number;
	pollApplicationSamples?: number;
	consecutiveSlowApplicationSamples?: number;
	lastOkAt: number;
	inFlight: number;
}

const APPLICATION_SWITCH_MARGIN_MS = Math.max(
	0,
	Number(process.env.LINE_H2_APPLICATION_SWITCH_MARGIN_MS ?? 0.5),
);
const IN_FLIGHT_PENALTY_MS = Math.max(
	0,
	Number(process.env.LINE_H2_IN_FLIGHT_PENALTY_MS ?? 4),
);

function estimatedSendRtt(lane: LaneChoiceMetrics): number | undefined {
	if (lane.sendRttMs !== undefined) {
		// A send lane may go quiet after losing a race. Adjust its last real
		// application sample by the change in continuously refreshed H2 PING so
		// a recovered Akamai route can become eligible again without issuing a
		// duplicate or synthetic chat message.
		if (lane.rttMs !== undefined && lane.sendNetworkRttMs !== undefined) {
			return Math.max(0, lane.sendRttMs + lane.rttMs - lane.sendNetworkRttMs);
		}
		return lane.sendRttMs;
	}
	return lane.pollRttMs ?? lane.rttMs;
}

function measuredApplicationRtt(lane: LaneChoiceMetrics): number | undefined {
	if (lane.sendRttMs === undefined) return lane.pollRttMs;
	if (lane.pollRttMs === undefined) return lane.sendRttMs;
	return (lane.lastPollOkAt ?? 0) > (lane.lastSendOkAt ?? 0)
		? lane.pollRttMs
		: lane.sendRttMs;
}

function applicationSampleAt(lane: LaneChoiceMetrics): number {
	return Math.max(lane.lastSendOkAt ?? 0, lane.lastPollOkAt ?? 0);
}

function hasFreshEligibleApplicationSample(
	lane: LaneChoiceMetrics,
	now: number,
	ceilingMs: number = APPLICATION_HOT_CEILING_MS,
	maxAgeMs: number = APPLICATION_SAMPLE_MAX_AGE_MS,
): boolean {
	const rtt = measuredApplicationRtt(lane);
	const sampleAt = applicationSampleAt(lane);
	return rtt !== undefined && rtt < ceilingMs && sampleAt > 0 && now - sampleAt <= maxAgeMs;
}

/**
 * Fresh sub-hot routes win first, then fresh routes below the hard discard
 * threshold. A known route at/above the discard threshold is never selected;
 * returning no candidate deliberately hands the request to the caller's
 * existing global-fetch fallback rather than delaying or dropping it.
 */
export function sendCandidatesWithCrossover<T extends LaneChoiceMetrics & { id: number }>(
	usable: T[],
	reserved: number = SEND_RESERVED_LANES,
	now: number = Date.now(),
	hotCeilingMs: number = APPLICATION_HOT_CEILING_MS,
	discardCeilingMs: number = APPLICATION_DISCARD_CEILING_MS,
	maxAgeMs: number = APPLICATION_SAMPLE_MAX_AGE_MS,
): T[] {
	const hot = usable.filter((lane) =>
		hasFreshEligibleApplicationSample(lane, now, hotCeilingMs, maxAgeMs)
	);
	const warm = usable.filter((lane) => {
		const rtt = measuredApplicationRtt(lane);
		return rtt !== undefined && rtt >= hotCeilingMs &&
			hasFreshEligibleApplicationSample(lane, now, discardCeilingMs, maxAgeMs);
	});
	const idleHot = hot.filter((lane) => lane.inFlight === 0);
	if (idleHot.length > 0) return idleHot;
	const idleWarm = warm.filter((lane) => lane.inFlight === 0);
	if (idleWarm.length > 0) return idleWarm;
	if (hot.length > 0) return hot;
	if (warm.length > 0) return warm;

	// Preserve an unmeasured/stale-but-not-known-slow reserved route so a new
	// session can calibrate. Routes already measured >= discard stay excluded
	// even after the sample ages out.
	const safeFallback = laneCandidates(usable, "send", reserved).filter((lane) => {
		const rtt = measuredApplicationRtt(lane);
		return rtt === undefined || rtt < discardCeilingMs;
	});
	if (safeFallback.length > 0) {
		const idle = safeFallback.filter((lane) => lane.inFlight === 0);
		return idle.length > 0 ? idle : safeFallback;
	}
	return [];
}

/** Applies the exact 0.50ms handoff rule to real application measurements. */
export function shouldPreferFastestSendLane(
	candidate: LaneChoiceMetrics,
	current: LaneChoiceMetrics,
	marginMs: number = APPLICATION_SWITCH_MARGIN_MS,
): boolean {
	const candidateRtt = measuredApplicationRtt(candidate);
	const currentRtt = measuredApplicationRtt(current);
	if (candidateRtt !== undefined && currentRtt === undefined) return true;
	if (candidateRtt === undefined && currentRtt !== undefined) return false;
	if (candidateRtt !== undefined && currentRtt !== undefined) {
		const improvementMs = currentRtt - candidateRtt;
		if (improvementMs > 0 && improvementMs >= marginMs) return true;
		if (improvementMs < 0 && -improvementMs >= marginMs) return false;
		// Both lanes have real measurements but the difference is below the
		// handoff margin. Retain the current route; freshness must not turn a
		// 0.49ms fluctuation into a lane switch.
		return false;
	}
	return shouldPreferLane(candidate, current, "send");
}

/** Pure lane-ranking rule, exported so the latency preference is testable. */
export function shouldPreferLane(
	candidate: LaneChoiceMetrics,
	current: LaneChoiceMetrics,
	role: LaneRole,
): boolean {
	const candidateRtt = role === "send" ? estimatedSendRtt(candidate) : candidate.pollRttMs ?? candidate.rttMs;
	const currentRtt = role === "send" ? estimatedSendRtt(current) : current.pollRttMs ?? current.rttMs;
	if (candidateRtt !== undefined && currentRtt === undefined) return true;
	if (candidateRtt !== undefined && currentRtt !== undefined) {
		const margin = role === "send" ? APPLICATION_SWITCH_MARGIN_MS : RTT_SWITCH_MARGIN_MS;
		const candidateScore = candidateRtt + candidate.inFlight * IN_FLIGHT_PENALTY_MS;
		const currentScore = currentRtt + current.inFlight * IN_FLIGHT_PENALTY_MS;
		if (candidateScore + margin < currentScore) return true;
		if (currentScore + margin < candidateScore) return false;
	}

	return role === "send"
		? candidate.lastOkAt > current.lastOkAt ||
			(candidate.lastOkAt === current.lastOkAt && candidate.inFlight < current.inFlight)
		: candidate.inFlight < current.inFlight ||
			(candidate.inFlight === current.inFlight && candidate.lastOkAt > current.lastOkAt);
}

/** Pure adaptive poll decision used by the live pool and focused tests. */
export function selectPollingLaneCandidate<T extends LaneChoiceMetrics & { id: number; lastPollOkAt: number }>(
	candidates: T[],
	cursor: number,
	explore: boolean,
	hotCeilingMs: number = APPLICATION_HOT_CEILING_MS,
	discardCeilingMs: number = APPLICATION_DISCARD_CEILING_MS,
	calibrationSamples: number = POLL_LANE_CALIBRATION_SAMPLES,
	discardConfirmationSamples: number = DEGRADED_REPAIR_MIN_SAMPLES,
): T | undefined {
	if (candidates.length === 0) return undefined;
	// A connection's first application response is commonly a cold outlier.
	// Give every physical route a tiny fixed calibration window before normal
	// ranking; these are the same polls the room already issues, not probes.
	const calibrating = candidates.filter((lane) =>
		lane.pollRttMs === undefined ||
		(lane.pollApplicationSamples !== undefined && lane.pollApplicationSamples < calibrationSamples)
	);
	if (calibrating.length > 0) {
		return calibrating.find((lane) => lane.id > cursor) ?? calibrating[0];
	}
	// Prefer HOT routes, retain 20-23ms routes only as fallback, and never
	// explore a known discarded route while any sub-discard route is ready.
	const hot = candidates.filter((lane) => lane.pollRttMs! < hotCeilingMs);
	const warm = candidates.filter((lane) => lane.pollRttMs! < discardCeilingMs);
	const selectable = hot.length > 0 ? hot : warm.length > 0 ? warm : candidates;
	if (explore) {
		// A route that crossed 23ms once remains send-ineligible, but polling
		// gives it enough spaced confirmations to distinguish a transient spike
		// from a path that really needs reconnecting.
		const suspects = candidates.filter((lane) =>
			lane.pollRttMs! >= discardCeilingMs &&
			(lane.consecutiveSlowApplicationSamples ?? discardConfirmationSamples) < discardConfirmationSamples
		);
		const explorePool = warm.length > 0 ? [...warm, ...suspects] : selectable;
		return [...explorePool].sort((left, right) =>
			left.lastPollOkAt - right.lastPollOkAt || left.id - right.id
		)[0];
	}
	let best = selectable[0]!;
	for (const candidate of selectable.slice(1)) {
		if (shouldPreferLane(candidate, best, "poll")) best = candidate;
	}
	return best;
}

function isBetterLane(candidate: Lane, current: Lane, role: LaneRole): boolean {
	return shouldPreferLane(candidate, current, role);
}

function recordLaneRtt(lane: Lane, sampleMs: number): void {
	if (!Number.isFinite(sampleMs) || sampleMs < 0) return;
	// A light EWMA follows a route change without letting one noisy ping move
	// every subsequent request to a different socket.
	lane.rttMs = lane.rttMs === undefined ? sampleMs : lane.rttMs * 0.7 + sampleMs * 0.3;
}

function recordApplicationRtt(lane: Lane, role: LaneRole, sampleMs: number): void {
	if (!Number.isFinite(sampleMs) || sampleMs < 0) return;
	const now = Date.now();
	lane.consecutiveSlowApplicationSamples = sampleMs >= APPLICATION_DISCARD_CEILING_MS
		? lane.consecutiveSlowApplicationSamples + 1
		: 0;
	if (role === "poll") {
		// Follow recovery quickly: cold first responses must not poison a lane
		// for minutes. Three samples at this weight reduce a one-off outlier to
		// 12.25% while repeated slow responses remain unmistakably slow.
		lane.pollRttMs = lane.pollRttMs === undefined ? sampleMs : lane.pollRttMs * 0.35 + sampleMs * 0.65;
		lane.pollApplicationSamples++;
		lane.lastPollOkAt = now;
		return;
	}
	lane.sendRttMs = lane.sendRttMs === undefined ? sampleMs : lane.sendRttMs * 0.65 + sampleMs * 0.35;
	lane.sendNetworkRttMs = lane.rttMs;
	lane.lastSendOkAt = now;
}

function pingLane(lane: Lane): void {
	if (!isUsable(lane)) return;
	const startedAt = performance.now();
	try {
		lane.session!.ping((error: Error | null, duration: number) => {
			if (error) {
				retireLane(lane, "dead");
				return;
			}
			recordLaneRtt(lane, Number.isFinite(duration) ? duration : performance.now() - startedAt);
		});
	} catch {
		retireLane(lane, "dead");
	}
}

interface RecyclableLane {
	id: number;
	state: LaneState;
	inFlight: number;
	openedAt: number;
}

/**
 * Picks one known-slow idle connection only when a healthy application-tested
 * standby already exists. This is called by a timer, never by laneFetch, and
 * therefore cannot add a handshake or reconnect to the reply path.
 */
export function selectDegradedLaneForRepair<T extends RecyclableLane & LaneChoiceMetrics>(
	lanes: T[],
	ceilingMs: number = APPLICATION_DISCARD_CEILING_MS,
	minimumSlowSamples: number = 1,
): T | undefined {
	const ready = lanes.filter((lane) => lane.state === "ready");
	const measured = ready.filter((lane) => measuredApplicationRtt(lane) !== undefined);
	if (measured.length < 2) return undefined;
	// When every route is over the ceiling, retain the fastest measured lane
	// as the live fallback while one worse idle connection looks for a new
	// edge. This makes forward progress without ever draining the best route.
	const fastest = [...measured].sort((left, right) =>
		measuredApplicationRtt(left)! - measuredApplicationRtt(right)! || left.id - right.id
	)[0]!;

	return measured
		.filter((lane) => {
			const rtt = measuredApplicationRtt(lane);
			return lane.id !== fastest.id && lane.inFlight === 0 && rtt !== undefined && rtt >= ceilingMs &&
				(lane.consecutiveSlowApplicationSamples ?? 0) >= minimumSlowSamples;
		})
		.sort((left, right) =>
			(measuredApplicationRtt(right)! - measuredApplicationRtt(left)!) ||
			applicationSampleAt(left) - applicationSampleAt(right) ||
			left.id - right.id
		)[0];
}

function repairDegradedLane(lanes: Lane[], now: number): boolean {
	if (lanes.length === 0) return false;
	const origin = lanes[0]!.origin;
	if (now - (lastDegradedRepairAt.get(origin) ?? now) < DEGRADED_REPAIR_MIN_GAP_MS) return false;
	const candidate = selectDegradedLaneForRepair(
		lanes.filter(isUsable),
		APPLICATION_DISCARD_CEILING_MS,
		DEGRADED_REPAIR_MIN_SAMPLES,
	);
	if (!candidate) return false;

	lastDegradedRepairAt.set(origin, now);
	console.log(
		`[h2-lanes] background repair: lane ${candidate.id} ` +
			`application=${measuredApplicationRtt(candidate)!.toFixed(1)}ms ` +
			`discard=${APPLICATION_DISCARD_CEILING_MS.toFixed(1)}ms ` +
			`slowSamples=${candidate.consecutiveSlowApplicationSamples} (origin=${origin})`,
	);
	retireLane(candidate, "draining");
	return true;
}

/**
 * Chooses at most one old, idle lane while preserving a ready standby in the
 * same send/poll partition. Exported as a pure rule so the rolling refresh
 * safety rails do not depend on timing-heavy socket tests.
 */
export function selectAgedLaneForRecycle<T extends RecyclableLane>(
	lanes: T[],
	now: number,
	maxAgeMs: number,
	reservedSendLanes: number = SEND_RESERVED_LANES,
): T | undefined {
	if (maxAgeMs <= 0) return undefined;
	const ready = lanes.filter((lane) => lane.state === "ready");
	const aged = ready
		.filter((lane) => lane.inFlight === 0 && lane.openedAt > 0 && now - lane.openedAt >= maxAgeMs)
		.sort((left, right) => left.openedAt - right.openedAt || left.id - right.id);

	for (const candidate of aged) {
		const candidateIsSend = reservedSendLanes > 0 && candidate.id < reservedSendLanes;
		const hasSamePartitionStandby = ready.some((lane) => {
			if (lane.id === candidate.id) return false;
			if (reservedSendLanes === 0) return true;
			return (lane.id < reservedSendLanes) === candidateIsSend;
		});
		if (hasSamePartitionStandby) return candidate;
	}
	return undefined;
}

function recycleAgedLane(lanes: Lane[], now: number): void {
	if (LANE_MAX_AGE_MS === 0 || LANE_RECYCLE_MIN_GAP_MS === 0 || lanes.length === 0) return;
	const origin = lanes[0]!.origin;
	if (now - (lastLaneRecycleAt.get(origin) ?? 0) < LANE_RECYCLE_MIN_GAP_MS) return;
	const candidate = selectAgedLaneForRecycle(
		lanes.filter(isUsable),
		now,
		LANE_MAX_AGE_MS,
	);
	if (!candidate) return;

	lastLaneRecycleAt.set(origin, now);
	console.log(
		`[h2-lanes] refreshing aged idle lane ${candidate.id} ` +
			`(age=${Math.round((now - candidate.openedAt) / 1_000)}s, origin=${origin})`,
	);
	// The selector requires inFlight=0 and a ready standby in the same
	// partition. "draining" rechecks that invariant in retireLane before the
	// physical socket is destroyed and re-opened with the latest DNS route.
	retireLane(candidate, "draining");
}

function retireLane(lane: Lane, state: "draining" | "dead"): void {
	if (lane.state === "dead") return;
	if (preferredSendLaneIds.get(lane.origin) === lane.id) preferredSendLaneIds.delete(lane.origin);
	lane.state = state;
	// A draining lane still has to finish the requests already on it; only a
	// dead one is safe to tear down immediately.
	if (state === "dead") {
		lane.session?.destroy();
		lane.session = undefined;
		scheduleReconnect(lane);
	} else if (lane.inFlight === 0) {
		retireLane(lane, "dead");
	}
}

function scheduleReconnect(lane: Lane): void {
	if (lane.disposed || lane.reconnectTimer) return;
	const delay = Math.min(RECONNECT_MAX_DELAY_MS, 250 * 2 ** Math.min(lane.consecutiveFailures, 5));
	lane.reconnectTimer = setTimeout(() => {
		lane.reconnectTimer = undefined;
		void openLane(lane).catch(() => {});
	}, delay);
	lane.reconnectTimer.unref?.();
}

function openLane(lane: Lane): Promise<void> {
	if (lane.disposed) return Promise.reject(new Error("lane pool stopped"));
	if (lane.state === "connecting" || isUsable(lane)) return Promise.resolve();
	lane.state = "connecting";
	// A reconnected lane is a new network route even when it reuses the same
	// pool slot. Never rank it using a PING measurement from the dead socket.
	lane.rttMs = undefined;
	lane.sendRttMs = undefined;
	lane.sendNetworkRttMs = undefined;
	lane.pollRttMs = undefined;
	lane.lastSendOkAt = 0;
	lane.lastPollOkAt = 0;
	lane.pollApplicationSamples = 0;
	lane.consecutiveSlowApplicationSamples = 0;
	lane.openedAt = 0;

	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const session = connectHttp2(lane.origin, { session: sessionTickets.get(lane.origin) });

		// Deliberately ref'd: an in-progress connect plus its timeout are the
		// only things driving this attempt, and unref'ing both leaves nothing
		// to keep the loop turning long enough to deliver the socket's own
		// error. The session is unref'd once established, below, so an idle
		// pool never holds the process open.
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			session.destroy();
			fail(new Error(`lane connect timeout (${lane.origin})`));
		}, CONNECT_TIMEOUT_MS);

		const fail = (error: Error): void => {
			clearTimeout(timer);
			lane.consecutiveFailures++;
			lane.state = "dead";
			lane.session = undefined;
			scheduleReconnect(lane);
			reject(error);
		};

		session.once("connect", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			// The pool must never be the reason the process cannot exit.
			session.unref?.();
			lane.session = session;
			lane.state = "ready";
			lane.consecutiveFailures = 0;
			lane.openedAt = Date.now();
			// Tiny Thrift frames should never wait behind Nagle's algorithm.
			const socket = session.socket;
			if ("setNoDelay" in socket && typeof socket.setNoDelay === "function") socket.setNoDelay(true);
			// Cache each fresh ticket so the *next* connect to this origin can
			// resume instead of paying a full handshake again.
			if ("on" in socket && typeof socket.on === "function") {
				socket.on("session", (ticket: Buffer) => sessionTickets.set(lane.origin, ticket));
			}
			// Probe every newly resolved IP. DNS can hand adjacent connections
			// routes whose RTT differs by several milliseconds; without this,
			// `lastOkAt` pins all hot traffic to whichever lane happened to carry
			// the first poll, even when a faster standby is already connected.
			pingLane(lane);
			// A brand-new lane is unproven, so `pickLane` keeps preferring the
			// lane that has actually carried traffic until this one is needed.
			resolve();
		});

		// GOAWAY is LINE announcing this connection is finished. Taking the
		// lane out of rotation the instant it arrives — rather than finding
		// out when a reply fails on it — is the entire point of owning these
		// connections instead of using the shared fetch pool.
		session.on("goaway", () => retireLane(lane, "draining"));
		session.on("error", (error: Error) => {
			if (!settled) {
				settled = true;
				fail(error);
				return;
			}
			lane.consecutiveFailures++;
			retireLane(lane, "dead");
		});
		session.on("close", () => {
			if (!settled) {
				settled = true;
				fail(new Error(`lane closed before connect (${lane.origin})`));
				return;
			}
			retireLane(lane, "dead");
		});
	});
}

function startPingTimer(): void {
	if (pingTimer) return;
	pingTimer = setInterval(() => {
		const now = Date.now();
		for (const lanes of pools.values()) {
			for (const lane of lanes) {
				if (!isUsable(lane)) {
					if (lane.state === "dead" && !lane.reconnectTimer) scheduleReconnect(lane);
					continue;
				}
				pingLane(lane);
			}
			// Never let age refresh and degraded-route repair drain two lanes in
			// the same timer tick. A measured slow path gets priority.
			if (!repairDegradedLane(lanes, now)) recycleAgedLane(lanes, now);
		}
	}, PING_INTERVAL_MS);
	pingTimer.unref?.();
}

/**
 * Brings `origin`'s lanes up and resolves once at least one can carry a
 * send. Safe to call repeatedly — it repairs whatever is missing.
 *
 * Keying on the full origin rather than the hostname is what stops a lane
 * built for `https://legy.line-apps.com` from ever being handed a request
 * for a different scheme or port on the same name.
 */
export async function ensureLanes(origin: string): Promise<void> {
	if (LANE_COUNT === 0) return;
	const url = new URL(origin);
	const key = url.origin;
	let lanes = pools.get(key);
	if (!lanes) {
		lanes = Array.from({ length: LANE_COUNT }, (_unused, id): Lane => ({
			id,
			origin: key,
			authority: url.host,
			state: "dead",
			inFlight: 0,
			lastOkAt: 0,
			rttMs: undefined,
			sendRttMs: undefined,
			sendNetworkRttMs: undefined,
			pollRttMs: undefined,
			lastSendOkAt: 0,
			lastPollOkAt: 0,
			pollApplicationSamples: 0,
			consecutiveFailures: 0,
			consecutiveSlowApplicationSamples: 0,
			openedAt: 0,
			disposed: false,
		}));
		pools.set(key, lanes);
		lastDegradedRepairAt.set(key, Date.now());
	}
	startPingTimer();
	const results = await Promise.allSettled(lanes.map((lane) => openLane(lane)));
	if (!lanes.some(isUsable)) {
		const reason = results.find((result) => result.status === "rejected");
		throw reason?.status === "rejected" ? reason.reason : new Error(`no usable lane for ${key}`);
	}
}

export function buildHeaders(
	authority: string,
	scheme: string,
	path: string,
	method: string,
	init?: RequestInit,
): OutgoingHttpHeaders {
	const headers: OutgoingHttpHeaders = {
		":method": method,
		":path": path,
		":scheme": scheme,
		":authority": authority,
	};
	const source = init?.headers;
	const entries: Array<[string, string]> = source instanceof Headers
		? [...source.entries()]
		: Array.isArray(source)
		? source as Array<[string, string]>
		: Object.entries((source ?? {}) as Record<string, string>);

	for (const [rawKey, value] of entries) {
		if (value === undefined || value === null) continue;
		const key = rawKey.toLowerCase();
		// Connection-specific headers are illegal in HTTP/2, and `host` is
		// carried by `:authority`.
		if (
			key === "host" || key === "connection" || key === "keep-alive" ||
			key === "transfer-encoding" || key === "upgrade" || key === "proxy-connection" ||
			key === "accept-encoding" || key === H2_LANE_ROLE_HEADER
		) {
			continue;
		}
		headers[key] = String(value);
	}
	// `fetch` transparently decompresses; node:http2 does not. Asking for an
	// identity body keeps the hot path free of both LINE's compression work
	// and ours, on a response of a few hundred bytes where gzip saves
	// nothing. `decodeBody` still handles a compressed reply defensively.
	headers["accept-encoding"] = "identity";
	return headers;
}

function toBodyBytes(body: BodyInit | null | undefined): Uint8Array | undefined {
	if (body === null || body === undefined) return undefined;
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (typeof body === "string") return new TextEncoder().encode(body);
	throw new TypeError("lane transport supports only string/binary bodies");
}

export function decodeBody(body: Uint8Array, encoding: string | undefined): Uint8Array {
	switch (encoding) {
		case undefined:
		case "":
		case "identity":
			return body;
		case "gzip":
			return new Uint8Array(gunzipSync(body));
		case "deflate":
			return new Uint8Array(inflateSync(body));
		case "br":
			return new Uint8Array(brotliDecompressSync(body));
		default:
			throw new Error(`unsupported content-encoding: ${encoding}`);
	}
}

/**
 * Resolves `undefined` only when the stream could never be opened, i.e.
 * when nothing at all reached LINE and falling back to `fetch` cannot
 * duplicate a message. Every failure after that point rejects: a reset
 * stream carries no proof the request went unprocessed, and this pool's
 * whole premise is that a reply is delivered at most once.
 */
function sendOnLane(
	lane: Lane,
	url: URL,
	init: RequestInit | undefined,
	body: Uint8Array | undefined,
	role: LaneRole,
): Promise<Response | undefined> {
	const session = lane.session!;
	const startedAt = performance.now();
	const headers = buildHeaders(
		lane.authority,
		url.protocol.slice(0, -1),
		`${url.pathname}${url.search}`,
		init?.method ?? "GET",
		init,
	);

	return new Promise<Response | undefined>((resolve, reject) => {
		let stream: ClientHttp2Stream;
		try {
			stream = session.request(headers, { endStream: body === undefined });
		} catch {
			// The session died between `pickLane` and here. Nothing was sent,
			// so the caller's fetch fallback is safe.
			retireLane(lane, "dead");
			resolve(undefined);
			return;
		}

		lane.inFlight++;
		let settled = false;
		let responseHeaders: Record<string, string> = {};
		let status = 0;
		let streamError: Error | undefined;
		const chunks: Uint8Array[] = [];
		const signal = init?.signal ?? undefined;

		function abortReason(): Error {
			return signal?.reason instanceof Error ? signal.reason : new Error("lane request aborted");
		}

		function settle(action: () => void): void {
			if (settled) return;
			settled = true;
			lane.inFlight--;
			signal?.removeEventListener("abort", onAbort);
			if (lane.state === "draining" && lane.inFlight === 0) retireLane(lane, "dead");
			action();
		}

		function onAbort(): void {
			// `close` follows the cancel and finds the promise already settled.
			settle(() => {
				stream.close(constants.NGHTTP2_CANCEL);
				reject(abortReason());
			});
		}

		if (signal) {
			if (signal.aborted) {
				settle(() => {
					stream.close(constants.NGHTTP2_CANCEL);
					reject(abortReason());
				});
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		stream.once("response", (received) => {
			status = Number(received[":status"] ?? 0);
			responseHeaders = Object.fromEntries(
				Object.entries(received)
					.filter((entry): entry is [string, string] => !entry[0].startsWith(":") && typeof entry[1] === "string"),
			);
		});
		stream.on("data", (chunk: Uint8Array) => chunks.push(chunk));
		// Recorded, not acted on. A reset stream emits `end` before `error`,
		// so deciding on either one alone would either resolve an empty
		// failed response or miss the RST code that says whether the request
		// was processed. `close` always comes last and always carries it.
		stream.on("error", (error: Error) => {
			streamError ??= error;
		});
		stream.once("close", () => settle(() => {
			const rstCode = stream.rstCode ?? constants.NGHTTP2_NO_ERROR;
			// A missing `:status` is the reliable signal that this stream
			// produced no response. Bun leaves `rstCode` at 0 on a reset
			// stream and does not surface its `error` event, so neither can
			// be the thing this decision rests on.
			if (rstCode !== constants.NGHTTP2_NO_ERROR || status === 0) {
				const detail = streamError?.message ?? `stream closed without a response (RST ${rstCode})`;
				reject(streamError ?? new Error(`lane ${lane.id} request failed: ${detail}`));
				return;
			}
			try {
				const raw = chunks.length === 1 ? chunks[0]! : new Uint8Array(Buffer.concat(chunks));
				const decoded = decodeBody(raw, responseHeaders["content-encoding"]);
				lane.lastOkAt = Date.now();
				const elapsedMs = performance.now() - startedAt;
				recordApplicationRtt(lane, role, elapsedMs);
				const shouldScore = role === "send" || (role === "poll" && shouldScorePollLane(lane.origin, lane.id));
				if (shouldScore && role !== undefined) {
					setImmediate(() => {
						const metric = role === "send" ? "sendRttMs" : "pollRttMs";
						const known = lanesForOrigin(lane.origin)
							.map((candidate) => candidate[metric])
							.filter((rtt): rtt is number => rtt !== undefined);
						recordLaneRace(role, lane.origin, lane.id, elapsedMs, known.length > 0 ? Math.min(...known) : undefined);
					});
				}
				const response = new Response(decoded as BodyInit, { status, headers: responseHeaders });
				resolve(attachRawDispatchBody(response, decoded));
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		}));

		if (body !== undefined) stream.end(body);
	});
}

function lanesForOrigin(origin: string): Lane[] {
	return pools.get(origin) ?? [];
}

/**
 * Sends one request over the healthiest owned lane.
 *
 * Returns `undefined` when no lane could carry it, which is the caller's
 * signal to use `globalThis.fetch` exactly as before — the pool is an
 * optimization, never a dependency.
 *
 * Exactly one lane is ever tried. Failing over happens *between* sends,
 * not within one: a lane LINE has GOAWAY'd or dropped is marked unusable
 * the moment that arrives, so the next reply simply picks another. That is
 * the whole benefit here, and it costs no risk of sending twice.
 */
export function laneFetch(info: RequestInfo | URL, init?: RequestInit): Promise<Response | undefined> {
	if (LANE_COUNT === 0) return undefined;
	const url = info instanceof URL ? info : new URL(typeof info === "string" ? info : info.url);
	const lanes = pools.get(url.origin);
	if (!lanes) return undefined;

	// Polls identify themselves explicitly. Every other hot one-shot call is
	// a send/control request and should benefit from send affinity.
	const role = requestRole(init) ?? "send";
	const lane = pickLane(lanes, role);
	if (!lane) return undefined;

	return sendOnLane(lane, url, init, toBodyBytes(init?.body as BodyInit | null | undefined), role);
}

export function laneStats(): LaneStat[] {
	const stats: LaneStat[] = [];
	const now = Date.now();
	for (const [origin, lanes] of pools) {
		for (const lane of lanes) {
			const applicationRttMs = measuredApplicationRtt(lane);
			stats.push({
				origin,
				id: lane.id,
				state: lane.state,
				inFlight: lane.inFlight,
				lastOkAt: lane.lastOkAt,
				rttMs: lane.rttMs,
				sendRttMs: lane.sendRttMs,
				pollRttMs: lane.pollRttMs,
				lastSendOkAt: lane.lastSendOkAt,
				lastPollOkAt: lane.lastPollOkAt,
				applicationRttMs,
				applicationSampleAt: applicationSampleAt(lane),
				routingEligible: isUsable(lane) && hasFreshEligibleApplicationSample(lane, now),
				consecutiveFailures: lane.consecutiveFailures,
				openedAt: lane.openedAt,
			});
		}
	}
	return stats;
}

/** Tears the pool down — used by tests and shutdown, not by the hot path. */
export function stopLanes(): void {
	if (pingTimer) clearInterval(pingTimer);
	pingTimer = undefined;
	for (const lanes of pools.values()) {
		for (const lane of lanes) {
			lane.disposed = true;
			if (lane.reconnectTimer) clearTimeout(lane.reconnectTimer);
			lane.reconnectTimer = undefined;
			lane.state = "dead";
			lane.session?.destroy();
			lane.session = undefined;
		}
	}
	pools.clear();
	preferredSendLaneIds.clear();
	pollCursorIds.clear();
	lastPollExploreAt.clear();
	lastLaneRecycleAt.clear();
	lastDegradedRepairAt.clear();
}
