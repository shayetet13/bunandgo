/**
 * SQLite adapter for the bot-owning Server2 workers. Keeping this in a
 * separate module keeps persistence concerns out of the lane scoring module
 * or side effect while preserving the dashboard's persisted history on S2.
 */
import { db } from "../db/sqlite.ts";
import { enqueueLaneRace } from "../db/write-behind.ts";
import {
	configureLaneRacePersistence,
	hydrateLaneRace,
	LANE_RACE_RETENTION_DAYS,
	type LaneRaceDaily,
	type PersistedLaneRaceEvent,
	type PersistedLaneRaceScore,
	WORKER_ID,
} from "./lane-race.ts";

const RETENTION_MS = LANE_RACE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const MAX_RECENT_EVENTS = 240;

function loadPersistedRace(): void {
	const since = Date.now() - RETENTION_MS;
	const scores = db
		.query<PersistedLaneRaceScore, [string, number]>(
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
	const events = db
		.query<PersistedLaneRaceEvent, [string, number, number]>(
			`
		SELECT ts, origin, lane_id, role, result, rtt_ms
		FROM lane_race_events
		WHERE worker_id = ? AND ts >= ?
		ORDER BY ts DESC LIMIT ?
	`,
		)
		.all(WORKER_ID, since, MAX_RECENT_EVENTS)
		.reverse();
	hydrateLaneRace(scores, events);
}

function dailyHistory(): LaneRaceDaily[] {
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

if (process.env.NODE_ENV !== "test") loadPersistedRace();
configureLaneRacePersistence((event) => {
	if (process.env.NODE_ENV === "test") return;
	enqueueLaneRace({ workerId: WORKER_ID, ...event });
}, dailyHistory);
