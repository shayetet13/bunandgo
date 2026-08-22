/**
 * Records the competition after a send has already completed. This module is
 * deliberately called from `setImmediate`: it is a spectator of the reply
 * path, never a condition for resolving a response to the bot.
 */
import { db } from "../db/sqlite.ts";
import { enqueueLaneRace } from "../db/write-behind.ts";

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
const RETENTION_MS = LANE_RACE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
/** Exported so anything tagging a response with "which process is this" (the
 * dashboard merge in metrics.ts/health.ts, the lane relay's own reports)
 * reads the exact same value this module already persists events under. */
export const WORKER_ID = process.env.WORKER_ID?.trim() || "standalone";

export interface LaneRaceEvent {
	ts: number;
	origin: string;
	laneId: number;
	role: LaneRaceRole;
	result: LaneRaceResult;
	rttMs: number;
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

interface PersistedScoreRow {
	origin: string;
	lane_id: number;
	role: LaneRaceRole;
	samples: number;
	stars: number;
	bananas: number;
	avg_rtt_ms: number;
	last_at: number;
}

interface PersistedEventRow {
	ts: number;
	origin: string;
	lane_id: number;
	role: LaneRaceRole;
	result: LaneRaceResult;
	rtt_ms: number;
}

function hydratePersistedRace(): void {
	const since = Date.now() - RETENTION_MS;
	const persistedScores = db
		.query<PersistedScoreRow, [string, number]>(
			`
		SELECT origin, lane_id, role, COUNT(*) AS samples,
			SUM(result = 'star') AS stars, SUM(result = 'banana') AS bananas,
			AVG(rtt_ms) AS avg_rtt_ms, MAX(ts) AS last_at
		FROM lane_race_events
		WHERE worker_id = ? AND ts >= ?
		GROUP BY origin, lane_id, role
	`,
		)
		.all(WORKER_ID, since);
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
	const persistedEvents = db
		.query<PersistedEventRow, [string, number, number]>(
			`
		SELECT ts, origin, lane_id, role, result, rtt_ms
		FROM lane_race_events
		WHERE worker_id = ? AND ts >= ?
		ORDER BY ts DESC LIMIT ?
	`,
		)
		.all(WORKER_ID, since, MAX_RECENT_EVENTS)
		.reverse();
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

if (process.env.NODE_ENV !== "test") hydratePersistedRace();

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
	return db
		.query<LaneRaceDaily, [string, number]>(
			`
		SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', '+7 hours') AS day,
			SUM(result = 'star') AS stars,
			SUM(result = 'banana') AS bananas,
			SUM(role = 'send' AND result = 'star') AS send_stars,
			SUM(role = 'send' AND result = 'banana') AS send_bananas,
			SUM(role = 'poll' AND result = 'star') AS poll_stars,
			SUM(role = 'poll' AND result = 'banana') AS poll_bananas
		FROM lane_race_events
		WHERE worker_id = ? AND ts >= ?
		GROUP BY day ORDER BY day
	`,
		)
		.all(WORKER_ID, Date.now() - RETENTION_MS);
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

export function recordLaneRace(role: LaneRaceRole, origin: string, laneId: number, rttMs: number, benchmarkMs: number | undefined): void {
	const event: LaneRaceEvent = {
		ts: Date.now(),
		origin,
		laneId,
		role,
		result: scoreLaneRtt(rttMs, benchmarkMs),
		rttMs,
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
	// This function already runs in setImmediate after the request resolved.
	// postMessage copies one tiny object; SQLite batches on another event loop.
	if (process.env.NODE_ENV !== "test") {
		enqueueLaneRace({
			workerId: WORKER_ID,
			ts: event.ts,
			origin: event.origin,
			laneId: event.laneId,
			role: event.role,
			result: event.result,
			rttMs: event.rttMs,
		});
	}
}
