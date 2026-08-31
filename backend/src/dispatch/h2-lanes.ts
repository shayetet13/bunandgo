import { connect as connectHttp2, constants, type ClientHttp2Session, type ClientHttp2Stream, type OutgoingHttpHeaders } from "node:http2";
import { lookup as lookupDns } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { connect as connectTcp } from "node:net";
import { connect as connectTls, type ConnectionOptions as TlsConnectionOptions } from "node:tls";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { attachRawDispatchBody } from "./raw-response.ts";
import { laneRaceScore, recordLaneRace, shouldScorePollLane, type LaneRaceScore } from "./lane-race.ts";
import {
	effectiveSendSlowThresholdMs,
	holdsSendPin,
	nextSendSlowUntil,
	qualifiesForSendPin,
	sendCandidatesOutsideCooldown,
} from "./lane-speed-policy.ts";
import {
	freshSendRouteProfile,
	getOrCreateSendRouteProfile,
	predictSendCompletion,
	recordSendRouteSample,
	SEND_SAMPLE_WINDOW,
	type SendRouteProfile,
} from "./send-prediction.ts";

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

/**
 * How many low-numbered lanes carry sends only, with poll traffic kept off
 * them entirely.
 *
 * Polling and sending share one pool, and enough concurrent pollers can leave
 * every proven-fast lane occupied.
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

/**
 * Consecutive slow SEND results (see `effectiveSendSlowThresholdMs` in
 * lane-speed-policy.ts) before a lane is flagged degraded rather than just
 * cooled for one round. One slow sample already earns a temporary cooldown
 * (`sendSlowUntil`) so the very next send avoids it; that cooldown always
 * expires and hands the lane back into rotation regardless of whether the
 * route actually recovered. A lane whose route has genuinely soured (not
 * noise) keeps failing the same way every time it cycles back in — this
 * requires several such results in a row before concluding that, not one.
 *
 * Deliberately reuses the same relative threshold as the cooldown rather
 * than a separate fixed ceiling: an earlier fixed 23ms ceiling here sat
 * under the live p50 and cooled/would-have-flagged a large slice of
 * perfectly healthy sends (see lane-speed-policy.ts's own history of this).
 */
const LANE_DEGRADED_MIN_SAMPLES = Math.max(2, Math.trunc(Number(process.env.LINE_H2_LANE_DEGRADED_MIN_SAMPLES ?? 3)) || 3);
/** Minimum spacing between degraded-lane repairs on the same origin — independent of age-based recycling's own gap so the two never compete for one slot's budget. */
const LANE_DEGRADED_REPAIR_MIN_GAP_MS = recycleInterval(process.env.LINE_H2_LANE_DEGRADED_REPAIR_GAP_MS, 60_000);

const CONNECT_TIMEOUT_MS = 10_000;
/** Backoff ceiling for a host that is refusing connections outright. */
const RECONNECT_MAX_DELAY_MS = 8_000;
/** Re-read /etc/hosts often enough to pick up the six-hourly fast-IP refresh. */
function addressCacheInterval(raw: string | undefined): number {
	const value = Number(raw ?? 60_000);
	return Number.isFinite(value) && value >= 1_000 ? value : 60_000;
}

const ADDRESS_CACHE_MS = addressCacheInterval(process.env.LINE_H2_ADDRESS_CACHE_MS);

/**
 * Offline per-IP HTTPS median written by scripts/pin-legy-fast-ips.sh on its
 * six-hourly run: `{ "<ip>": <medianMs> }`. A cold lane with no fresh real SEND
 * sample is ranked by this instead of its HTTP/2 PING — PING terminates at a
 * cheap Akamai edge (~1-3ms) and made every cold lane look faster than any
 * genuinely measured route, so the selector never converged. Absent or
 * unreadable file → the old `lane.rttMs` fallback, so nothing breaks before the
 * updated pin script has run anywhere.
 */
// Resolved on every read, not cached at module load so tests can point it at a
// fixture and the six-hourly pin run's path override takes effect without a restart.
function ipRankFilePath(): string {
	return process.env.LINE_H2_IP_RANK_FILE?.trim() || "/opt/linebot/shared/legy-ip-rank.json";
}
let ipRankCache: { at: number; map: Map<string, number> } | undefined;

function loadIpRankFile(): Map<string, number> {
	const map = new Map<string, number>();
	try {
		const parsed = JSON.parse(readFileSync(ipRankFilePath(), "utf8")) as Record<string, unknown>;
		for (const [ip, ms] of Object.entries(parsed)) {
			if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) map.set(ip, ms);
		}
	} catch {
		// No ranking file yet, or malformed — callers fall back to PING.
	}
	return map;
}

function ipRankPriorMs(address: string | undefined, now: number = Date.now()): number | undefined {
	if (!address) return undefined;
	if (!ipRankCache || now - ipRankCache.at > ADDRESS_CACHE_MS) {
		ipRankCache = { at: now, map: loadIpRankFile() };
	}
	return ipRankCache.map.get(address);
}

type LaneState = "connecting" | "ready" | "draining" | "dead";
export type LaneRole = "send" | "poll" | "warm" | undefined;

/** Process-local routing hint. It is stripped before anything reaches LINE. */
export const H2_LANE_ROLE_HEADER = "x-linebot-h2-role";
/** Stable process-local bot identity used only for lane prediction. */
export const H2_LANE_ROUTE_KEY_HEADER = "x-linebot-lane-route-key";

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
	/** Median of the three latest real round trips, separated by workload. */
	sendRttMs?: number;
	pollRttMs?: number;
	/** Small robust windows. The public RTT fields above are their medians. */
	sendRttSamples: number[];
	pollRttSamples: number[];
	/** Per-bot SEND history prevents one account's upstream jitter poisoning every bot. */
	sendRouteProfiles: Map<string, SendRouteProfile>;
	/** Peer-advertised HTTP/2 concurrency; queue cost exists only at this boundary. */
	streamCapacity?: number;
	lastSendOkAt: number;
	lastPollOkAt: number;
	/** A raw SEND result above 23ms temporarily removes this lane while another route is available. */
	sendSlowUntil: number;
	/** Consecutive SEND results at or above the slow threshold; reset by any fast one. */
	consecutiveSlowSends: number;
	/** Set once `consecutiveSlowSends` reaches `LANE_DEGRADED_MIN_SAMPLES` — see `repairDegradedLane`. */
	degraded: boolean;
	consecutiveFailures: number;
	/** Wall-clock time this physical HTTP/2 session connected. */
	openedAt: number;
	/** Actual address selected for this physical session. */
	remoteAddress?: string;
	remoteFamily?: 4 | 6;
	/** Reconnects rotate this lane through the complete fast-address pool. */
	addressRotation: number;
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
	sendSlowUntil: number;
	degraded: boolean;
	/** Dashboard-only freshest role view; routing uses the role fields above. */
	applicationRttMs?: number;
	applicationSampleAt: number;
	routingPreferred: boolean;
	consecutiveFailures: number;
	openedAt: number;
	remoteAddress?: string;
	remoteFamily?: 4 | 6;
}

export interface LaneRouteAddress {
	address: string;
	family: 4 | 6;
}

interface AddressCacheEntry {
	addresses: LaneRouteAddress[];
	expiresAt: number;
	pending?: Promise<LaneRouteAddress[]>;
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
/** Per-bot soft affinity, re-evaluated against predicted completion every send. */
const preferredSendLaneIds = new Map<string, number>();
/** Same defensive bound as `MAX_SEND_ROUTE_PROFILES` in send-prediction.ts for the structurally identical per-bot map. */
const MAX_PREFERRED_SEND_LANES = 2_048;
/**
 * Per-route rotation cursor. When several lanes score within the switch margin
 * of the fastest — the normal case, since real lanes to the same fast-IP pool
 * differ by fractions of a millisecond — the send goes to each in turn instead
 * of the lowest id taking all of them, so every lane carries traffic and keeps
 * a fresh sample.
 */
const sendRoundRobinCursor = new Map<string, number>();
/** Last rolling lane replacement per origin; keeps replacements staggered. */
const lastLaneRecycleAt = new Map<string, number>();
/** Last degraded-lane repair per origin; a separate budget from age-based recycling. */
const lastLaneDegradedRepairAt = new Map<string, number>();
const addressCache = new Map<string, AddressCacheEntry>();
let pingTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Smallest integer > 1 that is coprime with `n`, or 1 when none exists (n<=2).
 * Used as a stride so consecutive lane ids do not land on consecutive
 * addresses: with a plain `+1` offset, the low-numbered reserved SEND lanes
 * (ids 0..reserved-1) always mapped onto addresses 0..reserved-1, so SEND
 * never touched the second half of the fast-IP pool and could not escape a
 * slow one even after the selector learned it was slow.
 */
export function laneAddressStride(n: number): number {
	if (n <= 2) return 1;
	const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
	for (let stride = 2; stride < n; stride++) {
		if (gcd(stride, n) === 1) return stride;
	}
	return 1;
}

/** Deterministic spread at startup; one-step rotation whenever a lane reconnects. */
export function selectLaneRouteAddress(addresses: readonly LaneRouteAddress[], laneId: number, rotation: number = 0): LaneRouteAddress {
	if (addresses.length === 0) throw new Error("no resolved lane addresses");
	const n = addresses.length;
	// laneId * stride visits every index exactly once as laneId spans 0..n-1,
	// interleaving IPv4/IPv6 (the pin file lists all v4 then all v6). `rotation`
	// still advances one step per reconnect so a lane walks the whole pool over
	// its lifetime.
	return addresses[(((laneId * laneAddressStride(n) + rotation) % n) + n) % n]!;
}

function originHostname(origin: string): string {
	const hostname = new URL(origin).hostname;
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

async function resolveLaneAddresses(origin: string): Promise<LaneRouteAddress[]> {
	const hostname = originHostname(origin);
	const now = Date.now();
	const cached = addressCache.get(hostname);
	if (cached?.pending) return cached.pending;
	if (cached && cached.addresses.length > 0 && cached.expiresAt > now) return cached.addresses;

	const previous = cached?.addresses ?? [];
	const pending = lookupDns(hostname, { all: true, verbatim: true })
		.then((results) => {
			const seen = new Set<string>();
			const addresses: LaneRouteAddress[] = [];
			for (const result of results) {
				if ((result.family !== 4 && result.family !== 6) || seen.has(result.address)) continue;
				seen.add(result.address);
				addresses.push({ address: result.address, family: result.family });
			}
			if (addresses.length === 0) throw new Error(`no addresses resolved for ${hostname}`);
			addressCache.set(hostname, { addresses, expiresAt: Date.now() + ADDRESS_CACHE_MS });
			return addresses;
		})
		.catch((error) => {
			if (previous.length > 0) {
				addressCache.set(hostname, { addresses: previous, expiresAt: Date.now() + ADDRESS_CACHE_MS });
				return previous;
			}
			addressCache.delete(hostname);
			throw error;
		});
	addressCache.set(hostname, { addresses: previous, expiresAt: cached?.expiresAt ?? 0, pending });
	return pending;
}

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

function requestRouteKey(init: RequestInit | undefined): string | undefined {
	const value = headerValue(init, H2_LANE_ROUTE_KEY_HEADER)?.trim();
	return value && value.length <= 64 ? value : undefined;
}

function sendAffinityKey(origin: string, routeKey: string | undefined): string {
	return `${origin}\0${routeKey ?? "shared"}`;
}

/** LRU-capped write, mirroring `getOrCreateSendRouteProfile`'s eviction in send-prediction.ts. */
function rememberPreferredSendLane(affinityKey: string, laneId: number): void {
	if (preferredSendLaneIds.has(affinityKey)) {
		// Refresh insertion order so eviction below removes the least-recently used key.
		preferredSendLaneIds.delete(affinityKey);
	} else if (preferredSendLaneIds.size >= MAX_PREFERRED_SEND_LANES) {
		const oldest = preferredSendLaneIds.keys().next().value as string | undefined;
		if (oldest !== undefined) preferredSendLaneIds.delete(oldest);
	}
	preferredSendLaneIds.set(affinityKey, laneId);
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
	const usable = pollingCandidatesForCalibration(lanes.filter(isUsable));
	if (usable.length === 0) return undefined;
	return selectPollingLaneCandidate(usable);
}

/** Includes every unmeasured physical lane for one safe poll calibration,
 * then restores the configured send/poll partition for steady-state work. */
export function pollingCandidatesForCalibration<T extends { id: number; pollRttMs?: number }>(
	allUsable: T[],
	reserved: number = SEND_RESERVED_LANES,
): T[] {
	const unmeasured = allUsable.filter((lane) => lane.pollRttMs === undefined);
	return unmeasured.length > 0 ? unmeasured : laneCandidates(allUsable, "poll", reserved);
}

function pickLane(lanes: Lane[], role: LaneRole, routeKey?: string): Lane | undefined {
	if (role === "poll") return pickPollingLane(lanes);
	const origin = lanes[0]?.origin;
	const usable = lanes.filter(isUsable);
	const candidates = role === "send" ? fastestSendCandidates(usable, routeKey) : laneCandidates(usable, role);
	if (role === "send") {
		const now = Date.now();
		const affinityKey = origin === undefined ? undefined : sendAffinityKey(origin, routeKey);
		const preferredId = affinityKey === undefined ? undefined : preferredSendLaneIds.get(affinityKey);
		const selected = selectFastestSendLaneCandidate(candidates, preferredId, routeKey, now);
		// Only remember a lane once it has actually proven itself worth holding
		// (see SEND_PIN_ENTER_MS) — never downgrade an existing pin to whatever
		// merely won this round, or a lane that lost outright to a real
		// improvement would keep "winning" future ties once it recovers. Reuses
		// the same `now` the selection above scored against, not a fresh
		// Date.now(), so the write-gate can never disagree with the score that
		// just decided the tie.
		if (affinityKey !== undefined && selected && qualifiesForSendPin(sendLaneScore(selected, candidates, routeKey, now))) {
			rememberPreferredSendLane(affinityKey, selected.id);
		}
		return selected;
	}

	let best: Lane | undefined;
	for (const lane of candidates) {
		if (best === undefined || isBetterLane(lane, best, role)) {
			best = lane;
		}
	}
	return best;
}

// Route differences below this are noise; retain the old freshness/load
// preference instead of bouncing streams between effectively equal paths.
const RTT_SWITCH_MARGIN_MS = Math.max(0, Number(process.env.LINE_H2_RTT_SWITCH_MARGIN_MS ?? 0.1));

interface LaneChoiceMetrics {
	rttMs?: number;
	sendRttMs?: number;
	pollRttMs?: number;
	lastSendOkAt?: number;
	lastPollOkAt?: number;
	lastOkAt: number;
	inFlight: number;
	sendSlowUntil?: number;
	sendRttSamples?: readonly number[];
	sendRouteProfiles?: ReadonlyMap<string, SendRouteProfile>;
	streamCapacity?: number;
	/** IP this physical session connected through, for the cold-path rank prior. */
	remoteAddress?: string;
}

const APPLICATION_SWITCH_MARGIN_MS = Math.max(0, Number(process.env.LINE_H2_APPLICATION_SWITCH_MARGIN_MS ?? 0.1));
const APPLICATION_RTT_WINDOW = SEND_SAMPLE_WINDOW;

function estimatedSendRtt(lane: LaneChoiceMetrics): number | undefined {
	return lane.sendRttMs ?? lane.rttMs;
}

/** Dashboard compatibility only. Routing never consumes this mixed view. */
function latestApplicationRtt(lane: LaneChoiceMetrics): number | undefined {
	if (lane.sendRttMs === undefined) return lane.pollRttMs;
	if (lane.pollRttMs === undefined) return lane.sendRttMs;
	return (lane.lastPollOkAt ?? 0) > (lane.lastSendOkAt ?? 0) ? lane.pollRttMs : lane.sendRttMs;
}

function applicationSampleAt(lane: LaneChoiceMetrics): number {
	return Math.max(lane.lastSendOkAt ?? 0, lane.lastPollOkAt ?? 0);
}

/**
 * Keeps every non-cooling route in the competition once any real SEND result
 * exists. A cold route stays ready but cannot outrank measured work using only
 * PING. If all measured routes are cooling, an unmeasured survivor can bootstrap
 * the next SEND; before the first SEND, the configured partition bootstraps it.
 */
export function fastestSendCandidates<T extends LaneChoiceMetrics & { id: number }>(
	usable: T[],
	routeKey?: string,
	now: number = Date.now(),
): T[] {
	const routeAvailable = usable.filter((lane) => {
		const routeProfile = freshSendRouteProfile(lane.sendRouteProfiles, routeKey, now);
		const slowUntil = routeKey ? (routeProfile?.slowUntil ?? 0) : (lane.sendSlowUntil ?? 0);
		return slowUntil <= now;
	});
	const available = routeAvailable.length > 0 ? routeAvailable : sendCandidatesOutsideCooldown(usable, now);
	if (available.some((lane) => lane.sendRttMs !== undefined)) return available;
	return laneCandidates(available, "send");
}

function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Scores every candidate in one common application-RTT scale. A measured lane
 * is ranked only by its real SEND median — in-flight streams are not invented
 * into milliseconds. A cold lane cannot outrank any measured SEND route merely
 * because its transport PING is low; PING is used only before the first real
 * SEND result exists.
 */
export function sendLaneScore(
	lane: LaneChoiceMetrics,
	candidates: LaneChoiceMetrics[],
	routeKey?: string,
	now: number = Date.now(),
): number {
	const routeProfile = freshSendRouteProfile(lane.sendRouteProfiles, routeKey, now);
	const prediction = predictSendCompletion(
		routeProfile?.samples ?? lane.sendRttSamples,
		routeProfile ? undefined : lane.sendRttMs,
		lane.inFlight,
		lane.streamCapacity,
	);
	if (prediction) return prediction.predictedMs;
	if (candidates.some((candidate) => candidate.sendRttMs !== undefined)) return Number.POSITIVE_INFINITY;
	// A genuinely cold lane (never sent this life — startup or fresh recycle)
	// is ranked by the offline per-IP HTTPS median, not its HTTP/2 PING:
	// PING ends at a cheap edge and made every cold lane look ~1-3ms and outrank
	// real routes. Before an address is known the score falls back to PING.
	return ipRankPriorMs(lane.remoteAddress, now) ?? lane.rttMs ?? Number.POSITIVE_INFINITY;
}

export function selectFastestSendLaneCandidate<T extends LaneChoiceMetrics & { id: number }>(
	candidates: T[],
	preferredId?: number,
	routeKey?: string,
	now: number = Date.now(),
): T | undefined {
	if (candidates.length === 0) return undefined;
	const scored = candidates.map((lane) => ({ lane, score: sendLaneScore(lane, candidates, routeKey, now) }));
	const bestScore = Math.min(...scored.map((entry) => entry.score));
	// Every lane within the switch margin of the fastest is an equally valid
	// choice — fastest first, then least loaded, then lowest id.
	const tied = scored
		.filter((entry) => entry.score <= bestScore + APPLICATION_SWITCH_MARGIN_MS)
		.sort((left, right) => left.score - right.score || left.lane.inFlight - right.lane.inFlight || left.lane.id - right.lane.id)
		.map((entry) => entry.lane);
	if (tied.length === 1) return tied[0]!;
	// A lane this bot has already proven fast enough to hold (SEND_PIN_ENTER_MS)
	// wins any genuine tie instead of being rotated away by round robin, so the
	// bot keeps riding the lane it already knows is good instead of bouncing
	// between statistically identical routes. This only ever settles a *tie*: a
	// lane outside the tie window always loses to a real improvement regardless
	// of the pin, and a pinned lane that has itself degraded past
	// SEND_PIN_EXIT_MS stops qualifying here.
	if (preferredId !== undefined) {
		const pinned = tied.find((lane) => lane.id === preferredId);
		if (pinned && holdsSendPin(sendLaneScore(pinned, candidates, routeKey, now))) return pinned;
	}
	// The paths left here are interchangeable, so rotate through them instead of
	// letting affinity or the lowest id take every send — that is what left the
	// other reserved lanes cold and unmeasured. `tied` is fastest-first, so the
	// rotation still favours the quickest of the equal set.
	const key = routeKey ?? "shared";
	const cursor = sendRoundRobinCursor.get(key) ?? 0;
	sendRoundRobinCursor.set(key, cursor + 1);
	return tied[cursor % tied.length]!;
}

/** Applies the exact 0.10ms handoff rule to real application measurements. */
export function shouldPreferFastestSendLane(
	candidate: LaneChoiceMetrics,
	current: LaneChoiceMetrics,
	marginMs: number = APPLICATION_SWITCH_MARGIN_MS,
	routeKey?: string,
): boolean {
	const pair = [candidate, current];
	const candidateRtt = sendLaneScore(candidate, pair, routeKey);
	const currentRtt = sendLaneScore(current, pair, routeKey);
	if (!Number.isFinite(candidateRtt) && !Number.isFinite(currentRtt)) return shouldPreferLane(candidate, current, "send");
	if (Number.isFinite(candidateRtt) && !Number.isFinite(currentRtt)) return true;
	if (!Number.isFinite(candidateRtt) && Number.isFinite(currentRtt)) return false;
	const improvementMs = currentRtt - candidateRtt;
	if (improvementMs > 0 && improvementMs >= marginMs) return true;
	if (improvementMs < 0 && -improvementMs >= marginMs) return false;
	// Both lanes have real predictions but the difference is below the
	// handoff margin. Retain the current route to avoid needless churn.
	return false;
}

/** Pure lane-ranking rule, exported so the latency preference is testable. */
export function shouldPreferLane(candidate: LaneChoiceMetrics, current: LaneChoiceMetrics, role: LaneRole): boolean {
	const candidateRtt = role === "send" ? estimatedSendRtt(candidate) : (candidate.pollRttMs ?? candidate.rttMs);
	const currentRtt = role === "send" ? estimatedSendRtt(current) : (current.pollRttMs ?? current.rttMs);
	if (candidateRtt !== undefined && currentRtt === undefined) return true;
	if (candidateRtt !== undefined && currentRtt !== undefined) {
		const margin = role === "send" ? APPLICATION_SWITCH_MARGIN_MS : RTT_SWITCH_MARGIN_MS;
		if (candidateRtt + margin <= currentRtt) return true;
		if (currentRtt + margin <= candidateRtt) return false;
	}

	return role === "send"
		? candidate.lastOkAt > current.lastOkAt || (candidate.lastOkAt === current.lastOkAt && candidate.inFlight < current.inFlight)
		: candidate.inFlight < current.inFlight || (candidate.inFlight === current.inFlight && candidate.lastOkAt > current.lastOkAt);
}

/** Pure adaptive poll decision used by the live pool and focused tests. */
export function selectPollingLaneCandidate<T extends LaneChoiceMetrics & { id: number; lastPollOkAt: number }>(
	candidates: T[],
): T | undefined {
	if (candidates.length === 0) return undefined;

	const lowest = (pool: T[], valueOf: (lane: T) => number | undefined): T => {
		let best = pool[0]!;
		for (const lane of pool.slice(1)) {
			const laneValue = valueOf(lane) ?? Number.POSITIVE_INFINITY;
			const bestValue = valueOf(best) ?? Number.POSITIVE_INFINITY;
			if (
				laneValue < bestValue ||
				(laneValue === bestValue && lane.inFlight < best.inFlight) ||
				(laneValue === bestValue && lane.inFlight === best.inFlight && lane.lastOkAt > best.lastOkAt) ||
				(laneValue === bestValue && lane.inFlight === best.inFlight && lane.lastOkAt === best.lastOkAt && lane.id < best.id)
			) {
				best = lane;
			}
		}
		return best;
	};

	// Every new/reconnected lane gets one real LINE poll before the pool settles
	// on a winner. This is the only safe way to discover a faster route without
	// racing or duplicating a user's outgoing message.
	const unmeasured = candidates.filter((lane) => lane.pollRttMs === undefined);
	if (unmeasured.length > 0) return lowest(unmeasured, (lane) => lane.rttMs);

	return lowest(candidates, (lane) => lane.pollRttMs);
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

function recordApplicationRtt(lane: Lane, role: LaneRole, sampleMs: number, routeKey?: string): void {
	if (!Number.isFinite(sampleMs) || sampleMs < 0) return;
	// HEAD / keepalives prove the connection still works, but they terminate
	// at a cheap edge route and are not representative of a real LINE RPC.
	// Counting them as sends makes an edge-only response look like a 1–2ms application path
	// and permanently pinned traffic to the one lane the warmer happened to
	// touch. Warm traffic updates lastOkAt only (in sendOnLane), never routing.
	if (role === "warm" || role === undefined) return;
	const now = Date.now();
	if (role === "poll") {
		lane.pollRttSamples.push(sampleMs);
		if (lane.pollRttSamples.length > APPLICATION_RTT_WINDOW) lane.pollRttSamples.shift();
		lane.pollRttMs = median(lane.pollRttSamples);
		lane.lastPollOkAt = now;
		return;
	}
	// Median-of-three rejects one transient LINE/Akamai spike while two
	// consecutive slow results still demote a genuinely degraded route.
	lane.sendRttSamples.push(sampleMs);
	if (lane.sendRttSamples.length > APPLICATION_RTT_WINDOW) lane.sendRttSamples.shift();
	lane.sendRttMs = median(lane.sendRttSamples);
	lane.lastSendOkAt = now;
	// Cool this lane only if it trails the fastest lane actually measured in
	// this pool — a fixed 23ms ceiling sat under the live p50 and cooled almost
	// every send, collapsing the ranking. `lane.sendRttMs` above already
	// includes this result, so a lane that is itself the fastest is compared
	// against itself and effectively never self-cools.
	const measuredSiblings = lanesForOrigin(lane.origin)
		.map((sibling) => sibling.sendRttMs)
		.filter((rtt): rtt is number => rtt !== undefined);
	const slowThresholdMs = effectiveSendSlowThresholdMs(measuredSiblings.length > 0 ? Math.min(...measuredSiblings) : undefined);
	lane.sendSlowUntil = nextSendSlowUntil(Math.max(sampleMs, lane.sendRttMs ?? sampleMs), now, slowThresholdMs);
	if (routeKey) recordSendRouteSample(getOrCreateSendRouteProfile(lane.sendRouteProfiles, routeKey), sampleMs, now, slowThresholdMs);
	// A single slow result already earns the temporary cooldown above, which
	// always expires and hands the lane back into rotation on its own —
	// whether or not the route actually recovered. Only several results in a
	// row (same threshold, raw samples so one median-smoothed blip cannot
	// count double) conclude the route itself has soured, worth an actual
	// repair rather than one more cooldown cycle. See `repairDegradedLane`.
	if (sampleMs > slowThresholdMs) {
		lane.consecutiveSlowSends++;
		if (lane.consecutiveSlowSends >= LANE_DEGRADED_MIN_SAMPLES) lane.degraded = true;
	} else {
		lane.consecutiveSlowSends = 0;
		lane.degraded = false;
	}
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

interface DegradableLane {
	id: number;
	state: LaneState;
	inFlight: number;
	sendRttMs?: number;
	degraded: boolean;
}

/**
 * Chooses at most one idle, degraded lane to repair, favouring the worst
 * measured one and never the current fastest lane in the pool. Mirrors the
 * three safety rails this closes a gap for: never touch a lane with an
 * in-flight request, always leave at least one measured lane standing
 * before removing another, and the fastest lane is that guaranteed
 * survivor regardless of how the flag ended up set on it.
 */
export function selectDegradedLaneForRepair<T extends DegradableLane>(lanes: T[], minMeasuredLanes: number = 2): T | undefined {
	const measured = lanes.filter((lane) => lane.state === "ready" && lane.sendRttMs !== undefined);
	if (measured.length < minMeasuredLanes) return undefined;

	let fastest = measured[0]!;
	for (const lane of measured) {
		if (lane.sendRttMs! < fastest.sendRttMs!) fastest = lane;
	}

	let worst: T | undefined;
	for (const lane of measured) {
		if (lane.id === fastest.id || !lane.degraded || lane.inFlight !== 0) continue;
		if (worst === undefined || lane.sendRttMs! > worst.sendRttMs!) worst = lane;
	}
	return worst;
}

function repairDegradedLane(lanes: Lane[], now: number): void {
	if (lanes.length === 0) return;
	const origin = lanes[0]!.origin;
	if (now - (lastLaneDegradedRepairAt.get(origin) ?? 0) < LANE_DEGRADED_REPAIR_MIN_GAP_MS) return;
	const candidate = selectDegradedLaneForRepair(lanes.filter(isUsable));
	if (!candidate) return;

	lastLaneDegradedRepairAt.set(origin, now);
	console.log(
		`[h2-lanes] repairing degraded lane ${candidate.id} (sendRttMs=${candidate.sendRttMs?.toFixed(1)}, origin=${origin})`,
	);
	// Same retire path as age-based recycling: inFlight is already 0 here, so
	// "draining" resolves to "dead" immediately and scheduleReconnect picks a
	// fresh address on the next rotation step.
	retireLane(candidate, "draining");
}

function retireLane(lane: Lane, state: "draining" | "dead"): void {
	if (lane.state === "dead") return;
	for (const [key, laneId] of preferredSendLaneIds) {
		if (key.startsWith(`${lane.origin}\0`) && laneId === lane.id) preferredSendLaneIds.delete(key);
	}
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

async function openLane(lane: Lane): Promise<void> {
	if (lane.disposed) return Promise.reject(new Error("lane pool stopped"));
	if (lane.state === "connecting" || isUsable(lane)) return Promise.resolve();
	lane.state = "connecting";
	// A reconnected lane is a new network route even when it reuses the same
	// pool slot. Never rank it using a PING measurement from the dead socket.
	lane.rttMs = undefined;
	lane.sendRttMs = undefined;
	lane.pollRttMs = undefined;
	lane.sendRttSamples = [];
	lane.pollRttSamples = [];
	lane.sendRouteProfiles.clear();
	lane.streamCapacity = undefined;
	lane.lastSendOkAt = 0;
	lane.lastPollOkAt = 0;
	lane.sendSlowUntil = 0;
	lane.consecutiveSlowSends = 0;
	lane.degraded = false;
	lane.openedAt = 0;
	lane.remoteAddress = undefined;
	lane.remoteFamily = undefined;

	let addresses: LaneRouteAddress[];
	try {
		addresses = await resolveLaneAddresses(lane.origin);
	} catch (error) {
		lane.consecutiveFailures++;
		lane.state = "dead";
		scheduleReconnect(lane);
		throw error;
	}
	if (lane.disposed) throw new Error("lane pool stopped");
	// When the pool is larger than the address list (32 lanes over 8 IPs on the
	// another worker process), the stride alone puts `laneId % n`-equal lanes on the same
	// address. A fixed per-lane phase offset staggers those groups so all IPs
	// carry an equal share from the first connect, not only after reconnects.
	const rotationSeed = Math.floor(lane.id / addresses.length);
	const selectedAddress = selectLaneRouteAddress(addresses, lane.id, lane.addressRotation + rotationSeed);
	lane.addressRotation = (lane.addressRotation + 1) % addresses.length;

	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const tlsSession = sessionTickets.get(lane.origin);
		const session = connectHttp2(lane.origin, {
			session: tlsSession,
			// Bun drops TLS SNI when its HTTP/2 connector receives a custom DNS
			// callback, which makes LINE serve its default *.line.naver.jp cert.
			// Build the socket explicitly so the route uses the selected IP while
			// :authority, certificate verification and SNI keep the real hostname.
			createConnection: (authority, _options) => {
				const port = Number(authority.port || (authority.protocol === "https:" ? 443 : 80));
				if (authority.protocol === "https:") {
					const tlsOptions: TlsConnectionOptions = {
						host: selectedAddress.address,
						port,
						// No `family` here: `host` is already a resolved IP literal, not
						// a hostname, so there is no DNS lookup left for `family` to hint
						// -- and node:tls's ConnectionOptions type doesn't declare it
						// (unlike node:net's, used below for the plain-TCP branch).
						servername: originHostname(lane.origin),
						ALPNProtocols: ["h2"],
					};
					if (tlsSession) tlsOptions.session = tlsSession;
					return connectTls(tlsOptions);
				}
				return connectTcp({ host: selectedAddress.address, port, family: selectedAddress.family });
			},
		});
		session.on("remoteSettings", (settings) => {
			const capacity = settings.maxConcurrentStreams;
			lane.streamCapacity = Number.isFinite(capacity) && capacity > 0 ? capacity : undefined;
		});

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
			if (lane.disposed) {
				// The pool was torn down (stopLanes) while this handshake was
				// still in flight -- that call cannot cancel a connect already
				// underway, only mark the lane disposed and clear `pools`.
				// Without this check the lane below would resurrect itself as
				// "ready" holding a live session nothing in `pools` references
				// anymore, leaking the socket for the life of the process.
				session.destroy();
				reject(new Error("lane pool stopped"));
				return;
			}
			// The pool must never be the reason the process cannot exit.
			session.unref?.();
			lane.session = session;
			lane.state = "ready";
			lane.consecutiveFailures = 0;
			lane.openedAt = Date.now();
			// Tiny Thrift frames should never wait behind Nagle's algorithm.
			const socket = session.socket;
			lane.remoteAddress = socket.remoteAddress ?? selectedAddress.address;
			lane.remoteFamily = socket.remoteFamily === "IPv4" ? 4 : socket.remoteFamily === "IPv6" ? 6 : selectedAddress.family;
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
			// Once an origin has completed its startup prime, every replacement
			// connection must prime itself too. Otherwise a repair/GOAWAY quietly
			// turns one slot cold again even though the dashboard still describes
			// the pool as warmed. The HEAD remains unscored as real application
			// work; it only removes first-stream/path setup.
			if (primedOrigins.has(lane.origin)) {
				void primeLane(lane)
					.then(resolve)
					.catch((error) => {
						lane.consecutiveFailures++;
						retireLane(lane, "dead");
						reject(error instanceof Error ? error : new Error(String(error)));
					});
				return;
			}
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

/**
 * TEMPORARY: verifies the per-IP distribution added by "distribute H2 lanes
 * across fast LINE IPs" is actually spreading lanes across the pinned IP
 * set live, not clustering on one or two — the thing that broke silently
 * (SNI dropped, every lane failing) before this same feature's TLS fix.
 * Remove once confirmed stable over a real run.
 */
let distributionLogTick = 0;
function logLaneDistribution(): void {
	for (const [origin, lanes] of pools) {
		const byAddress = new Map<string, number>();
		let usableCount = 0;
		for (const lane of lanes) {
			if (!isUsable(lane)) continue;
			usableCount++;
			const key = lane.remoteAddress ?? "(unknown)";
			byAddress.set(key, (byAddress.get(key) ?? 0) + 1);
		}
		const summary = [...byAddress.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([ip, count]) => `${ip}=${count}`)
			.join(", ");
		console.log(`[lanes] ${origin} distribution: ${usableCount}/${lanes.length} usable — ${summary || "(none usable)"}`);
	}
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
			recycleAgedLane(lanes, now);
			repairDegradedLane(lanes, now);
		}
		// Every ~10th tick (2.5min at the current 15s interval) rather than
		// every tick, so this stays a diagnostic and not log spam over a long
		// unattended run.
		distributionLogTick = (distributionLogTick + 1) % 10;
		if (distributionLogTick === 0) logLaneDistribution();
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
			pollRttMs: undefined,
			sendRttSamples: [],
			pollRttSamples: [],
			sendRouteProfiles: new Map(),
			streamCapacity: undefined,
			lastSendOkAt: 0,
			lastPollOkAt: 0,
			sendSlowUntil: 0,
			consecutiveSlowSends: 0,
			degraded: false,
			consecutiveFailures: 0,
			openedAt: 0,
			remoteAddress: undefined,
			remoteFamily: undefined,
			addressRotation: 0,
			disposed: false,
		}));
		pools.set(key, lanes);
	}
	startPingTimer();
	const results = await Promise.allSettled(lanes.map((lane) => openLane(lane)));
	if (!lanes.some(isUsable)) {
		const reason = results.find((result) => result.status === "rejected");
		throw reason?.status === "rejected" ? reason.reason : new Error(`no usable lane for ${key}`);
	}
	// Immediate snapshot on first connect, not just the periodic one — see
	// logLaneDistribution's doc comment.
	logLaneDistribution();
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
		await Promise.all(lanes.map((lane) => primeLane(lane)));
		primedOrigins.add(key);
	})().finally(() => originPrimeRuns.delete(key));
	originPrimeRuns.set(key, run);
	return run;
}

async function primeLane(lane: Lane): Promise<void> {
	const response = await sendOnLane(
		lane,
		// Prime the same Akamai/application route the hot Square poll uses.
		// HEAD carries no LINE token or RPC body, so it cannot poll or send.
		new URL("/SQ1", lane.origin),
		{ method: "HEAD", signal: AbortSignal.timeout(10_000) },
		undefined,
		"warm",
		undefined,
	);
	if (!response) throw new Error(`lane ${lane.id} closed before its warm response`);
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
			key === H2_LANE_ROLE_HEADER ||
			key === H2_LANE_ROUTE_KEY_HEADER
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
	routeKey: string | undefined,
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
					recordApplicationRtt(lane, role, elapsedMs, routeKey);
					const shouldScore = role === "send" || (role === "poll" && shouldScorePollLane(lane.origin, lane.id));
					if (shouldScore && role !== undefined) {
						// Read now, not inside the setImmediate: this is the address that
						// actually served *this* request, and a retire between the two
						// clears `lane.remoteAddress` (see retireLane).
						const remoteIp = lane.remoteAddress;
						setImmediate(() => {
							const metric = role === "send" ? "sendRttMs" : "pollRttMs";
							const known = lanesForOrigin(lane.origin)
								.map((candidate) => candidate[metric])
								.filter((rtt): rtt is number => rtt !== undefined);
							recordLaneRace(role, lane.origin, lane.id, elapsedMs, known.length > 0 ? Math.min(...known) : undefined, remoteIp);
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
 * Lane selection is process-local. Deliberately NOT a duplicate race: exactly
 * one owned connection sends the request.
 */
export function laneFetch(info: RequestInfo | URL, init?: RequestInit): Promise<Response | undefined> {
	const url = info instanceof URL ? info : new URL(typeof info === "string" ? info : info.url);
	// Polls identify themselves explicitly. Every other hot one-shot call is
	// a send/control request and should benefit from send affinity.
	const role = requestRole(init) ?? "send";
	const routeKey = requestRouteKey(init);
	const lanes = LANE_COUNT === 0 ? undefined : pools.get(url.origin);
	const lane = lanes ? pickLane(lanes, role, routeKey) : undefined;
	if (!lane) return undefined;
	return sendOnLane(lane, url, init, toBodyBytes(init?.body as BodyInit | null | undefined), role, routeKey);
}

export function laneStats(): LaneStat[] {
	const stats: LaneStat[] = [];
	for (const [origin, lanes] of pools) {
		const sendMeasured = lanes.filter((lane) => isUsable(lane) && lane.sendRttMs !== undefined);
		const fastest = selectFastestSendLaneCandidate(fastestSendCandidates(sendMeasured));
		for (const lane of lanes) {
			const applicationRttMs = latestApplicationRtt(lane);
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
				sendSlowUntil: lane.sendSlowUntil,
				degraded: lane.degraded,
				applicationRttMs,
				applicationSampleAt: applicationSampleAt(lane),
				routingPreferred: isUsable(lane) && lane.id === fastest?.id,
				consecutiveFailures: lane.consecutiveFailures,
				openedAt: lane.openedAt,
				remoteAddress: lane.remoteAddress,
				remoteFamily: lane.remoteFamily,
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
	sendSlowUntil: number;
	routingPreferred: boolean;
	remoteAddress?: string;
	remoteFamily?: 4 | 6;
	send: LaneRaceScore;
	poll: LaneRaceScore;
}

/**
 * The exact shape the LANE RACE dashboard panel renders, built from this
 * process's own `laneStats()` + persisted scores for `/api/metrics/lane-race`.
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
		sendSlowUntil: lane.sendSlowUntil,
		routingPreferred: lane.routingPreferred,
		remoteAddress: lane.remoteAddress,
		remoteFamily: lane.remoteFamily,
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
	sendRoundRobinCursor.clear();
	lastLaneRecycleAt.clear();
	lastLaneDegradedRepairAt.clear();
	addressCache.clear();
	ipRankCache = undefined;
}
