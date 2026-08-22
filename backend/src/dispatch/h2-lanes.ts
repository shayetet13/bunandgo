import { connect as connectHttp2, constants, type ClientHttp2Session, type ClientHttp2Stream, type OutgoingHttpHeaders } from "node:http2";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { attachRawDispatchBody } from "./raw-response.ts";
import { laneRaceScore, recordLaneRace, shouldScorePollLane, type LaneRaceScore } from "./lane-race.ts";
import {
	dispatchViaRelay,
	recordRemoteDispatchEnd,
	recordRemoteDispatchStart,
	remoteDispatchConfig,
	remoteLaneCandidate,
} from "./remote-lane.ts";

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
 * message can never be delivered twice. Poll traffic stays on the fastest
 * proven application route; spare connections remain ready for failover.
 *
 * `LINE_H2_LANES=0` falls straight back to `globalThis.fetch`.
 */

// Polling keeps the application side of each connection hot while sends need
// enough alternatives to escape a stream that has just become slow. Six is a
// deliberate small pool: large enough to absorb several concurrent bot
// sessions without turning every account into its own connection pool.
const LANE_COUNT = Math.max(0, Number(process.env.LINE_H2_LANES ?? 6));

function relayOnlyEnabled(): boolean {
	return process.env.LINE_RELAY_MODE === "always";
}

/**
 * How many low-numbered lanes carry sends only, with poll traffic kept off
 * them entirely.
 *
 * Polling and sending share one pool, and enough concurrent pollers can leave
 * every proven-fast lane occupied; `IN_FLIGHT_PENALTY_MS` then scores those
 * routes as worse.
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
 * only behind interleaved application samples recorded by the lane metrics.
 *
 * Clamped to leave at least one lane for polling, and the reservation is
 * only ever a preference: if every reserved lane is down a send still uses
 * whatever is usable rather than failing.
 */
const SEND_RESERVED_LANES = Math.min(Math.max(0, Number(process.env.LINE_H2_SEND_RESERVED_LANES ?? 0)), Math.max(0, LANE_COUNT - 1));

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

const LANE_MAX_AGE_MS = recycleInterval(process.env.LINE_H2_LANE_MAX_AGE_MS, 15 * 60_000);
const LANE_RECYCLE_MIN_GAP_MS = recycleInterval(process.env.LINE_H2_LANE_RECYCLE_GAP_MS, 60_000);

/** A recent real LINE request, not edge-only H2 PING, gates hot routing.
 * 20/21 (not the older 18/20) on purpose: with a second, genuinely
 * independent network path (the lane relay, see remote-lane.ts) now a real
 * candidate, the ceiling has to fit its typical RTT too, not just local
 * lanes' — 18/20 measured against server3's own numbers rejected it almost
 * every time. These were previously only overridden via worker-topology.json
 * (whose value is authoritative in production either way); kept in sync here
 * so the source default stops silently lying about what's actually live. */
const APPLICATION_HOT_CEILING_MS = Math.max(
	0,
	Number(process.env.LINE_H2_APPLICATION_HOT_CEILING_MS ?? process.env.LINE_H2_APPLICATION_LANE_CEILING_MS ?? 20),
);
/** Known routes at or above this RTT are removed from foreground sends.
 * Widened from 21 back to 23 on purpose: the lane relay's own real,
 * single-session measurement averaged 21.4ms (range 17-30ms) — at 21 it was
 * being excluded outright most of the time rather than getting a genuine
 * shot at the warm tier. 23 gives it real room; the fastest-available lane
 * still always wins regardless of this ceiling, this only controls what
 * gets discarded entirely. */
const APPLICATION_DISCARD_CEILING_MS = Math.max(
	APPLICATION_HOT_CEILING_MS,
	Number(process.env.LINE_H2_APPLICATION_DISCARD_CEILING_MS ?? 23),
);
const APPLICATION_SAMPLE_MAX_AGE_MS = Math.max(1_000, Number(process.env.LINE_H2_APPLICATION_SAMPLE_MAX_AGE_MS ?? 30_000));
// Floor is a sanity minimum, not a policy default: repairDegradedLane() only
// ever retires an idle, already-known-slow lane in the background (never the
// fastest one, never one with inFlight work), so tightening this cannot slow
// down a live reply — it only changes how quickly a degraded route is retried.
// The 60s *default* (unset env) is unchanged; only the previously-hardcoded
// lower bound is relaxed so LINE_H2_DEGRADED_REPAIR_GAP_MS can actually lower
// it when that's deliberately chosen.
const DEGRADED_REPAIR_MIN_GAP_MS = Math.max(5_000, Number(process.env.LINE_H2_DEGRADED_REPAIR_GAP_MS ?? 60_000));
const DEGRADED_REPAIR_MIN_SAMPLES = Math.max(1, Math.floor(Number(process.env.LINE_H2_DEGRADED_REPAIR_MIN_SAMPLES ?? 3)));

const CONNECT_TIMEOUT_MS = 10_000;
/** Backoff ceiling for a host that is refusing connections outright. */
const RECONNECT_MAX_DELAY_MS = 8_000;

type LaneState = "connecting" | "ready" | "draining" | "dead";
export type LaneRole = "send" | "poll" | "warm" | undefined;

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
const primedOrigins = new Set<string>();
const originPrimeRuns = new Map<string, Promise<void>>();
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
/** Last rolling lane replacement per origin; keeps replacements staggered. */
const lastLaneRecycleAt = new Map<string, number>();
/** Background-only repair throttle; never awaited by a reply. */
const lastDegradedRepairAt = new Map<string, number>();
let pingTimer: ReturnType<typeof setInterval> | undefined;

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
	return value === "send" || value === "poll" || value === "warm" ? value : undefined;
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
export function laneCandidates<T extends { id: number }>(usable: T[], role: LaneRole, reserved: number = SEND_RESERVED_LANES): T[] {
	if (reserved === 0 || (role !== "send" && role !== "poll") || usable.length === 0) return usable;
	const preferred = usable.filter((lane) => (role === "send" ? lane.id < reserved : lane.id >= reserved));
	return preferred.length > 0 ? preferred : usable;
}

function pickPollingLane(lanes: Lane[]): Lane | undefined {
	const usable = laneCandidates(lanes.filter(isUsable), "poll");
	if (usable.length === 0) return undefined;
	return selectPollingLaneCandidate(usable);
}

function pickLane(lanes: Lane[], role: LaneRole): Lane | undefined {
	if (role === "poll") return pickPollingLane(lanes);
	const origin = lanes[0]?.origin;
	const usable = lanes.filter(isUsable);
	const candidates = role === "send" ? sendCandidatesWithCrossover(usable) : laneCandidates(usable, role);

	let best: Lane | undefined;
	for (const lane of candidates) {
		if (best === undefined || (role === "send" ? shouldPreferFastestSendLane(lane, best, 0) : isBetterLane(lane, best, role))) {
			best = lane;
		}
	}
	if (!best || origin === undefined) return best;

	const preferredId = preferredSendLaneIds.get(origin);
	// Looked up among the candidates, not every lane: when a reservation is
	// in force, affinity held from before must not pin sends to a poll lane.
	const preferred = preferredId === undefined ? undefined : candidates.find((lane) => lane.id === preferredId);
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
	consecutiveSlowApplicationSamples?: number;
	lastOkAt: number;
	inFlight: number;
}

const APPLICATION_SWITCH_MARGIN_MS = Math.max(0, Number(process.env.LINE_H2_APPLICATION_SWITCH_MARGIN_MS ?? 0.5));
const IN_FLIGHT_PENALTY_MS = Math.max(0, Number(process.env.LINE_H2_IN_FLIGHT_PENALTY_MS ?? 4));

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
	return (lane.lastPollOkAt ?? 0) > (lane.lastSendOkAt ?? 0) ? lane.pollRttMs : lane.sendRttMs;
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

/** A relay with a real hot sample is immediately usable. A brand-new relay
 * gets exactly one bootstrap attempt from its fresh edge PING, but only after
 * the local pool has already failed the 23ms ceiling; that attempt creates the
 * end-to-end Server 2 -> Server 3 -> LINE measurement used thereafter. */
export function canTryRemoteFallback(
	candidate: LaneChoiceMetrics,
	now: number = Date.now(),
	hotCeilingMs: number = APPLICATION_HOT_CEILING_MS,
): boolean {
	if (hasFreshEligibleApplicationSample(candidate, now, hotCeilingMs)) return true;
	return measuredApplicationRtt(candidate) === undefined && candidate.rttMs !== undefined && candidate.rttMs < hotCeilingMs;
}

/** Server 3 may replace a local route only after the local route has a real
 * measurement that misses the sub-20ms target (or no local route exists). */
export function shouldTryRemoteForLocal(
	localAvailable: boolean,
	localApplicationRtt: number | undefined,
	hotCeilingMs: number = APPLICATION_HOT_CEILING_MS,
): boolean {
	return !localAvailable || (localApplicationRtt !== undefined && localApplicationRtt >= hotCeilingMs);
}

/**
 * Fresh sub-hot routes win first, then fresh routes below the hard discard
 * threshold. A known route at/above the discard threshold is deprioritized
 * below every fresher/faster option, but is still the last resort when
 * nothing else qualifies: the caller's global-fetch fallback loses the warm
 * TLS/H2 connection entirely and measures slower than even the worst owned
 * lane, so an empty candidate list is only returned when there are truly no
 * usable lanes at all.
 */
export function sendCandidatesWithCrossover<T extends LaneChoiceMetrics & { id: number }>(
	usable: T[],
	reserved: number = SEND_RESERVED_LANES,
	now: number = Date.now(),
	hotCeilingMs: number = APPLICATION_HOT_CEILING_MS,
	discardCeilingMs: number = APPLICATION_DISCARD_CEILING_MS,
	maxAgeMs: number = APPLICATION_SAMPLE_MAX_AGE_MS,
): T[] {
	const hot = usable.filter((lane) => hasFreshEligibleApplicationSample(lane, now, hotCeilingMs, maxAgeMs));
	const warm = usable.filter((lane) => {
		const rtt = measuredApplicationRtt(lane);
		return rtt !== undefined && rtt >= hotCeilingMs && hasFreshEligibleApplicationSample(lane, now, discardCeilingMs, maxAgeMs);
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

	// Every reserved send lane has a real measurement at/above the discard
	// ceiling ("known slow", not merely stale or unmeasured — those already
	// took the safeFallback branch above). Surface the fastest of them rather
	// than an empty list; repairDegradedLane() is what pulls a lane like this
	// back under the ceiling in the background.
	const reservedCandidates = laneCandidates(usable, "send", reserved);
	if (reservedCandidates.length === 0) return [];
	let fastest = reservedCandidates[0]!;
	for (const lane of reservedCandidates) {
		if (shouldPreferFastestSendLane(lane, fastest, 0)) fastest = lane;
	}
	return [fastest];
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
export function shouldPreferLane(candidate: LaneChoiceMetrics, current: LaneChoiceMetrics, role: LaneRole): boolean {
	const candidateRtt = role === "send" ? estimatedSendRtt(candidate) : (candidate.pollRttMs ?? candidate.rttMs);
	const currentRtt = role === "send" ? estimatedSendRtt(current) : (current.pollRttMs ?? current.rttMs);
	if (candidateRtt !== undefined && currentRtt === undefined) return true;
	if (candidateRtt !== undefined && currentRtt !== undefined) {
		const margin = role === "send" ? APPLICATION_SWITCH_MARGIN_MS : RTT_SWITCH_MARGIN_MS;
		const candidateScore = candidateRtt + candidate.inFlight * IN_FLIGHT_PENALTY_MS;
		const currentScore = currentRtt + current.inFlight * IN_FLIGHT_PENALTY_MS;
		if (candidateScore + margin < currentScore) return true;
		if (currentScore + margin < candidateScore) return false;
	}

	return role === "send"
		? candidate.lastOkAt > current.lastOkAt || (candidate.lastOkAt === current.lastOkAt && candidate.inFlight < current.inFlight)
		: candidate.inFlight < current.inFlight || (candidate.inFlight === current.inFlight && candidate.lastOkAt > current.lastOkAt);
}

/** Pure adaptive poll decision used by the live pool and focused tests. */
export function selectPollingLaneCandidate<T extends LaneChoiceMetrics & { id: number; lastPollOkAt: number }>(
	candidates: T[],
	hotCeilingMs: number = APPLICATION_HOT_CEILING_MS,
	discardCeilingMs: number = APPLICATION_DISCARD_CEILING_MS,
): T | undefined {
	if (candidates.length === 0) return undefined;

	const fastest = (pool: T[]): T => {
		let best = pool[0]!;
		for (const lane of pool.slice(1)) {
			if (shouldPreferLane(lane, best, "poll")) best = lane;
		}
		return best;
	};

	// Foreground polls are user-visible latency. Once one route has proved it
	// can complete a real LINE RPC below 20ms, keep choosing the fastest proven
	// route instead of spending live polls to calibrate or periodically explore
	// unused connections. Those experiments were the controllable source of
	// recurring 24/30/40/80ms samples despite plenty of spare lanes.
	const hot = candidates.filter((lane) => lane.pollRttMs! < hotCeilingMs);
	if (hot.length > 0) return fastest(hot);

	// A 20-23ms route is allowed only when no sub-20ms route remains.
	const warm = candidates.filter((lane) => lane.pollRttMs! < discardCeilingMs);
	if (warm.length > 0) return fastest(warm);

	// Bootstrap exactly one unmeasured route only when there is no usable
	// measured route below 23ms. H2 PING is sufficient to pick which unknown
	// connection gets that unavoidable first real sample; it is never allowed
	// to outrank a proven application-fast lane.
	const unmeasured = candidates.filter((lane) => lane.pollRttMs === undefined);
	if (unmeasured.length > 0) return fastest(unmeasured);

	// Availability last resort. A >=23ms lane is used only if every alternative
	// is also known slow; background repair replaces these sessions.
	return fastest(candidates);
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
	// HEAD / keepalives prove the connection still works, but they terminate
	// at a cheap edge route and are not representative of a real LINE RPC.
	// Counting them as sends made Server 3 look like a 1–2ms application path
	// and permanently pinned traffic to the one lane the warmer happened to
	// touch. Warm traffic updates lastOkAt only (in sendOnLane), never routing.
	if (role === "warm" || role === undefined) return;
	const now = Date.now();
	lane.consecutiveSlowApplicationSamples = sampleMs >= APPLICATION_DISCARD_CEILING_MS ? lane.consecutiveSlowApplicationSamples + 1 : 0;
	if (role === "poll") {
		// Follow recovery quickly: cold first responses must not poison a lane
		// for minutes. Three samples at this weight reduce a one-off outlier to
		// 12.25% while repeated slow responses remain unmistakably slow.
		lane.pollRttMs = lane.pollRttMs === undefined ? sampleMs : lane.pollRttMs * 0.35 + sampleMs * 0.65;
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
 * Every idle, ready, over-ceiling lane that has confirmed the breach for
 * `minimumSlowSamples` consecutive samples, worst RTT first. When every
 * route is over the ceiling, the fastest measured lane is held back as the
 * live fallback so this never empties the pool down to zero candidates.
 *
 * Both `selectDegradedLaneForRepair()`'s single pick and the repair
 * scheduler's backlog count come from this one list, so they can never
 * drift out of sync with each other.
 */
export function degradedLaneCandidates<T extends RecyclableLane & LaneChoiceMetrics>(
	lanes: T[],
	ceilingMs: number,
	minimumSlowSamples: number,
): T[] {
	const ready = lanes.filter((lane) => lane.state === "ready");
	const measured = ready.filter((lane) => measuredApplicationRtt(lane) !== undefined);
	if (ready.length < 2 || measured.length === 0) return [];
	const fastest = [...measured].sort(
		(left, right) => measuredApplicationRtt(left)! - measuredApplicationRtt(right)! || left.id - right.id,
	)[0]!;
	// Protect the fastest measured route only when every ready connection is
	// already measured. If an unmeasured ready standby exists, a lone known-
	// slow route is safe to recycle: keeping it merely because it is the first
	// application-tested lane leaves a cold >=23ms relay slot stuck until a
	// later foreground request happens to calibrate another lane.
	const protectFastestMeasured = measured.length === ready.length;

	return measured
		.filter((lane) => {
			const rtt = measuredApplicationRtt(lane);
			return (
				(!protectFastestMeasured || lane.id !== fastest.id) &&
				lane.inFlight === 0 &&
				rtt !== undefined &&
				rtt >= ceilingMs &&
				(lane.consecutiveSlowApplicationSamples ?? 0) >= minimumSlowSamples
			);
		})
		.sort(
			(left, right) =>
				measuredApplicationRtt(right)! - measuredApplicationRtt(left)! ||
				applicationSampleAt(left) - applicationSampleAt(right) ||
				left.id - right.id,
		);
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
	return degradedLaneCandidates(lanes, ceilingMs, minimumSlowSamples)[0];
}

function repairDegradedLane(lanes: Lane[], now: number): boolean {
	if (lanes.length === 0) return false;
	const origin = lanes[0]!.origin;
	const candidates = degradedLaneCandidates(lanes.filter(isUsable), APPLICATION_DISCARD_CEILING_MS, DEGRADED_REPAIR_MIN_SAMPLES);
	if (candidates.length === 0) return false;

	// A lone degraded lane gets the full conservative gap -- no reason to
	// rush a one-off blip. Once a second lane is *simultaneously* idle and
	// over the ceiling, the repair queue is falling behind the rate lanes
	// are degrading at: production evidence (2026-08-20, legy.line-apps.com,
	// 21h/305 repairs) showed the gap sitting at its 60s floor in 56% of
	// gaps, with another lane already waiting the instant it reopened --
	// real reply p50 sat at 22.5ms against an 18-21ms target as a result.
	// Backing off to one repair per timer tick when a backlog exists is
	// still safe: this function is never called more than once per
	// PING_INTERVAL_MS (see startPingTimer), and never touches the fastest
	// lane or one with inFlight work either way.
	const effectiveGapMs = candidates.length > 1 ? PING_INTERVAL_MS : DEGRADED_REPAIR_MIN_GAP_MS;
	if (now - (lastDegradedRepairAt.get(origin) ?? now) < effectiveGapMs) return false;

	const candidate = candidates[0]!;
	lastDegradedRepairAt.set(origin, now);
	console.log(
		`[h2-lanes] background repair: lane ${candidate.id} ` +
			`application=${measuredApplicationRtt(candidate)!.toFixed(1)}ms ` +
			`discard=${APPLICATION_DISCARD_CEILING_MS.toFixed(1)}ms ` +
			`slowSamples=${candidate.consecutiveSlowApplicationSamples} backlog=${candidates.length} (origin=${origin})`,
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
			return lane.id < reservedSendLanes === candidateIsSend;
		});
		if (hasSamePartitionStandby) return candidate;
	}
	return undefined;
}

function recycleAgedLane(lanes: Lane[], now: number): void {
	if (LANE_MAX_AGE_MS === 0 || LANE_RECYCLE_MIN_GAP_MS === 0 || lanes.length === 0) return;
	const origin = lanes[0]!.origin;
	if (now - (lastLaneRecycleAt.get(origin) ?? 0) < LANE_RECYCLE_MIN_GAP_MS) return;
	const candidate = selectAgedLaneForRecycle(lanes.filter(isUsable), now, LANE_MAX_AGE_MS);
	if (!candidate) return;

	lastLaneRecycleAt.set(origin, now);
	console.log(
		`[h2-lanes] refreshing aged idle lane ${candidate.id} ` + `(age=${Math.round((now - candidate.openedAt) / 1_000)}s, origin=${origin})`,
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

/**
 * Exercises one harmless HEAD stream on every newly-created lane before bot
 * sessions resume. Opening TCP/TLS/H2 alone still left the first real poll on
 * a connection paying one-time stream/edge setup; priming the whole pool once
 * removes that cold start without fabricating application RTT samples.
 */
export function primeLanes(origin: string): Promise<void> {
	const key = new URL(origin).origin;
	if (primedOrigins.has(key)) return Promise.resolve();
	const existing = originPrimeRuns.get(key);
	if (existing) return existing;

	const run = (async () => {
		await ensureLanes(key);
		const lanes = pools.get(key)?.filter(isUsable) ?? [];
		if (lanes.length === 0) throw new Error(`no usable lane to prime for ${key}`);
		await Promise.all(
			lanes.map(async (lane) => {
				const response = await sendOnLane(
					lane,
					// Prime the same Akamai/application route the hot Square poll uses.
					// HEAD carries no LINE token or RPC body, so it cannot poll or send.
					new URL("/SQ1", key),
					{ method: "HEAD", signal: AbortSignal.timeout(10_000) },
					undefined,
					"warm",
				);
				if (!response) throw new Error(`lane ${lane.id} closed before its warm response`);
			}),
		);
		primedOrigins.add(key);
	})().finally(() => originPrimeRuns.delete(key));
	originPrimeRuns.set(key, run);
	return run;
}

export function buildHeaders(authority: string, scheme: string, path: string, method: string, init?: RequestInit): OutgoingHttpHeaders {
	const headers: OutgoingHttpHeaders = {
		":method": method,
		":path": path,
		":scheme": scheme,
		":authority": authority,
	};
	const source = init?.headers;
	const entries: Array<[string, string]> =
		source instanceof Headers
			? [...source.entries()]
			: Array.isArray(source)
				? (source as Array<[string, string]>)
				: Object.entries((source ?? {}) as Record<string, string>);

	for (const [rawKey, value] of entries) {
		if (value === undefined || value === null) continue;
		const key = rawKey.toLowerCase();
		// Connection-specific headers are illegal in HTTP/2, and `host` is
		// carried by `:authority`.
		if (
			key === "host" ||
			key === "connection" ||
			key === "keep-alive" ||
			key === "transfer-encoding" ||
			key === "upgrade" ||
			key === "proxy-connection" ||
			key === "accept-encoding" ||
			key === H2_LANE_ROLE_HEADER
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
	const headers = buildHeaders(lane.authority, url.protocol.slice(0, -1), `${url.pathname}${url.search}`, init?.method ?? "GET", init);

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
				Object.entries(received).filter((entry): entry is [string, string] => !entry[0].startsWith(":") && typeof entry[1] === "string"),
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
		stream.once("close", () =>
			settle(() => {
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
					// Same repair rule the ping timer runs, fired the instant a sample
					// crosses the ceiling instead of waiting up to PING_INTERVAL_MS for
					// the next tick to notice. Deferred past this reply's own resolve()
					// below so a degraded-lane retirement never adds latency to the
					// request that just measured it.
					if (role === "send" || role === "poll") {
						setImmediate(() => repairDegradedLane(lanesForOrigin(lane.origin), Date.now()));
					}
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
			}),
		);

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
 *
 * A second physical machine's h2-lanes pool (server3, see remote-lane.ts) is
 * folded in here as pure standby, never inside pickLane()/pickPollingLane()
 * themselves — those stay local-lanes-only. Deliberately NOT a duplicate
 * race: Server 3 is considered only when no local route has a proven sub-20ms
 * application sample. A local 20-23ms route remains the safe fallback when
 * Server 3 is not itself proven sub-20ms.
 */
export function laneFetch(info: RequestInfo | URL, init?: RequestInit): Promise<Response | undefined> {
	const url = info instanceof URL ? info : new URL(typeof info === "string" ? info : info.url);
	// Polls identify themselves explicitly. Every other hot one-shot call is
	// a send/control request and should benefit from send affinity.
	const role = requestRole(init) ?? "send";
	if (relayOnlyEnabled()) {
		const relayConfig = remoteDispatchConfig();
		if (!relayConfig) return Promise.reject(new Error("relay-only worker has no relay dispatch configuration"));
		return dispatchViaRemoteLane(relayConfig, url, init, role, true);
	}
	const lanes = LANE_COUNT === 0 ? undefined : pools.get(url.origin);
	const lane = lanes ? pickLane(lanes, role) : undefined;

	const localApplicationRtt = lane ? measuredApplicationRtt(lane) : undefined;
	const localMissesHotTarget = shouldTryRemoteForLocal(lane !== undefined, localApplicationRtt);
	if (localMissesHotTarget) {
		const relayConfig = remoteDispatchConfig();
		if (relayConfig) {
			const remote = remoteLaneCandidate(url.origin);
			const now = Date.now();
			// Held to the hot ceiling specifically, not the wider local discard
			// ceiling: with 32 standby lanes on server3 (raised from 6) there is
			// almost always a genuinely fast one among them, so overflow traffic
			// no longer needs to accept a merely-warm remote route the way it did
			// when server3 had far fewer lanes to pick the best of.
			const remoteEligible = remote !== undefined && canTryRemoteFallback(remote, now, APPLICATION_HOT_CEILING_MS);
			if (remoteEligible) {
				return dispatchViaRemoteLane(relayConfig, url, init, role);
			}
		}
	}

	if (!lane) return undefined;
	return sendOnLane(lane, url, init, toBodyBytes(init?.body as BodyInit | null | undefined), role);
}

async function dispatchViaRemoteLane(
	config: { url: string; token: string },
	url: URL,
	init: RequestInit | undefined,
	role: LaneRole,
	required = false,
): Promise<Response | undefined> {
	recordRemoteDispatchStart(url.origin);
	const startedAt = performance.now();
	const scoredRole = role === "send" || role === "poll" ? role : undefined;
	try {
		const response = await dispatchViaRelay(config, url, init, role);
		if (required && !response) throw new Error("lane relay unavailable before dispatch");
		recordRemoteDispatchEnd(url.origin, scoredRole, performance.now() - startedAt, APPLICATION_DISCARD_CEILING_MS);
		return response;
	} catch (error) {
		recordRemoteDispatchEnd(url.origin, scoredRole, performance.now() - startedAt, APPLICATION_DISCARD_CEILING_MS);
		throw error;
	}
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

export interface LaneRaceLaneView {
	origin: string;
	laneId: number;
	state: LaneState;
	inFlight: number;
	sendRttMs?: number;
	pollRttMs?: number;
	applicationRttMs?: number;
	applicationSampleAt: number;
	routingEligible: boolean;
	send: LaneRaceScore;
	poll: LaneRaceScore;
}

/**
 * The exact shape the LANE RACE dashboard panel renders, built from this
 * process's own `laneStats()` + persisted scores. Shared by `/api/metrics/
 * lane-race` (this process's own lanes) and the lane-relay service (which
 * ships the same shape for its own lanes to the control plane) so neither
 * has to duplicate the mapping.
 */
export function laneRaceView(): LaneRaceLaneView[] {
	return laneStats().map((lane) => ({
		origin: lane.origin,
		laneId: lane.id,
		state: lane.state,
		inFlight: lane.inFlight,
		sendRttMs: lane.sendRttMs,
		pollRttMs: lane.pollRttMs,
		applicationRttMs: lane.applicationRttMs,
		applicationSampleAt: lane.applicationSampleAt,
		routingEligible: lane.routingEligible,
		send: laneRaceScore(lane.origin, lane.id, "send"),
		poll: laneRaceScore(lane.origin, lane.id, "poll"),
	}));
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
	primedOrigins.clear();
	originPrimeRuns.clear();
	preferredSendLaneIds.clear();
	lastLaneRecycleAt.clear();
	lastDegradedRepairAt.clear();
}
