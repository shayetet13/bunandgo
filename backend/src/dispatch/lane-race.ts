/**
 * Records the competition after a send has already completed. This module is
 * deliberately called from `setImmediate`: it is a spectator of the reply
 * path, never a condition for resolving a response to the bot.
 */

export type LaneRaceResult = "star" | "banana";
export type LaneRaceRole = "send" | "poll";

const STAR_MARGIN_MS = 1.5;
// A poll can complete continuously while a room is active. Sampling once per
// lane per minute is enough to show a 30-day race without turning metrics
// writes into poll traffic or competing with a reply.
const POLL_SAMPLE_MS = Math.max(10_000, Number(process.env.LANE_RACE_POLL_SAMPLE_MS ?? 60_000));
const lastPollScoreAt = new Map<string, number>();
const MAX_RECENT_EVENTS = 240;
function retentionDays(): number {
	const value = Number(process.env.LANE_RACE_RETENTION_DAYS ?? 30);
	return Number.isFinite(value) ? Math.min(365, Math.max(1, value)) : 30;
}
export const LANE_RACE_RETENTION_DAYS = retentionDays();
/** Exported so anything tagging a response with "which process is this" (the
 * dashboard views in metrics.ts/health.ts)
 * reads the exact same value this module already persists events under. */
export const WORKER_ID = process.env.WORKER_ID?.trim() || "standalone";

export interface LaneRaceEvent {
	ts: number;
	origin: string;
	laneId: number;
	role: LaneRaceRole;
	result: LaneRaceResult;
	rttMs: number;
	/**
	 * Which LINE edge address this lane was actually talking to.
	 *
	 * A lane id is ephemeral — lanes recycle onto whatever DNS hands back
	 * every `laneMaxAgeMs` — so per-lane averages blur together the fast and
	 * slow endpoints a lane passed through. The address is the stable
	 * property that decides the speed: the one 25-minute window this was ever
	 * recorded (2026-08-25) had `2400:dcc0:a3a1:1001::1` averaging 13.3ms
	 * against `2400:dcc0:a303:b1a4::39` at 32.0ms — a 2.4x spread, where the
	 * slow endpoint's *best* sample was worse than the fast one's average.
	 * Per-lane numbers over the same period showed a 5ms spread and hid all
	 * of it. `ipRankPriorMs` already ranks cold lanes by address; this is
	 * what gives it something to rank with.
	 */
	remoteIp?: string;
}

export interface LaneRaceScore {
	samples: number;
	stars: number;
	bananas: number;
	bigStars: number;
	avgRttMs?: number;
	lastAt?: number;
	lastResult?: LaneRaceResult;
}

const recentEvents: LaneRaceEvent[] = [];
const scores = new Map<string, LaneRaceScore>();

function scoreKey(origin: string, laneId: number, role: LaneRaceRole): string {
	return `${origin}\u0000${laneId}\u0000${role}`;
}

export interface PersistedLaneRaceScore {
	origin: string;
	lane_id: number;
	role: LaneRaceRole;
	samples: number;
	stars: number;
	bananas: number;
	avg_rtt_ms: number;
	last_at: number;
}

export interface PersistedLaneRaceEvent {
	ts: number;
	origin: string;
	lane_id: number;
	role: LaneRaceRole;
	result: LaneRaceResult;
	rtt_ms: number;
}

export function hydrateLaneRace(persistedScores: PersistedLaneRaceScore[], persistedEvents: PersistedLaneRaceEvent[]): void {
	for (const row of persistedScores) {
		scores.set(scoreKey(row.origin, row.lane_id, row.role), {
			samples: row.samples,
			stars: row.stars,
			bananas: row.bananas,
			bigStars: Math.floor(row.stars / 10),
			avgRttMs: row.avg_rtt_ms,
			lastAt: row.last_at,
		});
	}
	for (const row of persistedEvents) {
		const event: LaneRaceEvent = {
			ts: row.ts,
			origin: row.origin,
			laneId: row.lane_id,
			role: row.role,
			result: row.result,
			rttMs: row.rtt_ms,
		};
		recentEvents.push(event);
		const score = scores.get(scoreKey(event.origin, event.laneId, event.role));
		if (score && (score.lastAt === undefined || event.ts >= score.lastAt)) {
			score.lastAt = event.ts;
			score.lastResult = event.result;
		}
	}
}

type PersistLaneRace = (event: LaneRaceEvent) => void;
let persistLaneRace: PersistLaneRace | undefined;
let dailyHistoryProvider: (() => LaneRaceDaily[]) | undefined;

/** Main backend installs persistence after topology validation. */
export function configureLaneRacePersistence(persist: PersistLaneRace, daily: () => LaneRaceDaily[]): void {
	persistLaneRace = persist;
	dailyHistoryProvider = daily;
}

/** A copy lets the API expose live data without allowing callers to mutate it. */
export function laneRaceScore(origin: string, laneId: number, role: LaneRaceRole): LaneRaceScore {
	const score = scores.get(scoreKey(origin, laneId, role));
	return score ? { ...score } : { samples: 0, stars: 0, bananas: 0, bigStars: 0 };
}

/** Recent in-memory window, hydrated from write-behind history at startup. */
export function laneRaceSnapshot(): { events: LaneRaceEvent[] } {
	return { events: recentEvents.map((event) => ({ ...event })) };
}

export interface LaneRaceDaily {
	day: string;
	stars: number;
	bananas: number;
	send_stars: number;
	send_bananas: number;
	poll_stars: number;
	poll_bananas: number;
}

/** Dashboard-only grouped read; never called by lane selection or replies. */
export function laneRaceDailyHistory(): LaneRaceDaily[] {
	return dailyHistoryProvider?.() ?? [];
}

export function scoreLaneRtt(rttMs: number, benchmarkMs: number | undefined): LaneRaceResult {
	// A request within noise of the healthiest lane earns a star. A lane that
	// is measurably slower gets a banana, then can earn a star on its next
	// sample. The same threshold is used for SEND and POLL races.
	return benchmarkMs === undefined || rttMs <= benchmarkMs + STAR_MARGIN_MS ? "star" : "banana";
}

/** Backwards-compatible name kept for focused scoring tests. */
export const scoreLaneSend = scoreLaneRtt;

/**
 * Reserve the one poll sample this lane may persist this minute. Called on
 * the poll completion path, but only performs two Map operations — no I/O,
 * timer, allocation of a write entry, or effect on the reply path.
 */
export function shouldScorePollLane(origin: string, laneId: number, now = Date.now()): boolean {
	const key = `${origin}\0${laneId}`;
	const previous = lastPollScoreAt.get(key);
	if (previous !== undefined && now - previous < POLL_SAMPLE_MS) return false;
	lastPollScoreAt.set(key, now);
	return true;
}

export function recordLaneRace(
	role: LaneRaceRole,
	origin: string,
	laneId: number,
	rttMs: number,
	benchmarkMs: number | undefined,
	remoteIp?: string,
): void {
	const event: LaneRaceEvent = {
		ts: Date.now(),
		origin,
		laneId,
		role,
		result: scoreLaneRtt(rttMs, benchmarkMs),
		rttMs,
		remoteIp,
	};
	recentEvents.push(event);
	if (recentEvents.length > MAX_RECENT_EVENTS) recentEvents.shift();

	const key = scoreKey(origin, laneId, role);
	const previous = scores.get(key);
	const samples = (previous?.samples ?? 0) + 1;
	const stars = (previous?.stars ?? 0) + (event.result === "star" ? 1 : 0);
	const bananas = (previous?.bananas ?? 0) + (event.result === "banana" ? 1 : 0);
	const previousTotal = (previous?.avgRttMs ?? 0) * (samples - 1);
	scores.set(key, {
		samples,
		stars,
		bananas,
		bigStars: Math.floor(stars / 10),
		avgRttMs: (previousTotal + rttMs) / samples,
		lastAt: event.ts,
		lastResult: event.result,
	});
	persistLaneRace?.(event);
}
