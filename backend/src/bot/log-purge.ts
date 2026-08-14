import { db } from "../db/sqlite.ts";

/**
 * Clears high-volume operational logs once a day at 23:00 Asia/Bangkok,
 * while retaining the lower-volume security audit trail for investigation.
 *
 * The app_meta timestamp survives a restart, so repeated scheduler checks (or
 * a redeploy during the 23:00 hour) cannot clear the tables more than once.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const PURGE_HOUR = 23;
const CHECK_INTERVAL_MS = 60 * 1000;
// Allow a little scheduling/restart drift while still preventing a second
// purge during the same 23:00 hour.
const MIN_GAP_MS = DAY_MS - 6 * 60 * 60 * 1000;
const LAST_PURGE_KEY = "last_log_purge_at";
function auditRetentionDays(): number {
	const value = Number(process.env.AUDIT_LOG_RETENTION_DAYS ?? 90);
	return Number.isFinite(value) ? Math.min(3_650, Math.max(1, value)) : 90;
}

const AUDIT_RETENTION_DAYS = auditRetentionDays();
const AUDIT_RETENTION_MS = AUDIT_RETENTION_DAYS * DAY_MS;
function laneRaceRetentionDays(): number {
	const value = Number(process.env.LANE_RACE_RETENTION_DAYS ?? 30);
	return Number.isFinite(value) ? Math.min(365, Math.max(1, value)) : 30;
}
const LANE_RACE_RETENTION_DAYS = laneRaceRetentionDays();
const LANE_RACE_RETENTION_MS = LANE_RACE_RETENTION_DAYS * DAY_MS;

const getMetaStmt = db.prepare<{ value: string }, [string]>("SELECT value FROM app_meta WHERE key = ?");
const setMetaStmt = db.prepare<null, [string, string]>(
	"INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);
const purgeBotEventsStmt = db.prepare("DELETE FROM bot_events");
const purgeExpiredUserActionsStmt = db.prepare("DELETE FROM user_actions WHERE ts < ?");
const purgeLatencyStmt = db.prepare("DELETE FROM latency_samples");
const purgeMessagesInStmt = db.prepare("DELETE FROM messages_in");
const purgeAnomaliesStmt = db.prepare("DELETE FROM anomalies");
const purgeExpiredLaneRaceStmt = db.prepare("DELETE FROM lane_race_events WHERE ts < ?");

function bangkokHour(now: Date): number {
	// Reads the local hour in Asia/Bangkok regardless of the host's own
	// timezone, so "23:00" means Thailand time whether the VPS is UTC or not.
	return Number(
		new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Bangkok", hour: "numeric", hourCycle: "h23" }).format(now),
	);
}

export function getLastPurgeAt(): number {
	return Number(getMetaStmt.get(LAST_PURGE_KEY)?.value ?? 0);
}

/** Exported for testing — pure decision, no clock or DB access of its own. */
export function shouldRunLogPurge(now: Date, lastPurgeAt: number): boolean {
	return bangkokHour(now) === PURGE_HOUR && now.getTime() - lastPurgeAt >= MIN_GAP_MS;
}

/** Clears operational logs and expires only old audit entries, atomically. */
export function runLogPurge(nowMs: number = Date.now()): void {
	db.transaction(() => {
		purgeBotEventsStmt.run();
		purgeExpiredUserActionsStmt.run(nowMs - AUDIT_RETENTION_MS);
		purgeLatencyStmt.run();
		purgeMessagesInStmt.run();
		purgeAnomaliesStmt.run();
		purgeExpiredLaneRaceStmt.run(nowMs - LANE_RACE_RETENTION_MS);
		setMetaStmt.run(LAST_PURGE_KEY, String(nowMs));
	})();
}

export function startLogPurgeScheduler(): void {
	const timer = setInterval(() => {
		const now = new Date();
		if (!shouldRunLogPurge(now, getLastPurgeAt())) return;
		runLogPurge(now.getTime());
		console.log(`[log-purge] cleared operational logs; retained audit=${AUDIT_RETENTION_DAYS}d lane-race=${LANE_RACE_RETENTION_DAYS}d (daily 23:00 Asia/Bangkok)`);
	}, CHECK_INTERVAL_MS);
	// A pending purge check must never be what keeps the process alive.
	timer.unref?.();
}
