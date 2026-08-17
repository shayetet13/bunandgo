import { describe, expect, test } from "bun:test";
import { db } from "../db/sqlite.ts";
import { getLastPurgeAt, runLogPurge, shouldRunLogPurge } from "./log-purge.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

// Asia/Bangkok is UTC+7 year-round (no DST) — 23:00 there is 16:00 UTC.
const AT_2300_BANGKOK = new Date("2026-01-15T16:00:00.000Z");
const AT_1200_BANGKOK = new Date("2026-01-15T05:00:00.000Z");

describe("shouldRunLogPurge", () => {
	test("stays false outside the 23:00 Bangkok window regardless of gap", () => {
		expect(shouldRunLogPurge(AT_1200_BANGKOK, 0)).toBe(false);
	});

	test("stays false at 23:00 if the last purge was recent", () => {
		const recently = AT_2300_BANGKOK.getTime() - 60_000;
		expect(shouldRunLogPurge(AT_2300_BANGKOK, recently)).toBe(false);
	});

	test("fires at 23:00 once roughly one day has passed", () => {
		const longAgo = AT_2300_BANGKOK.getTime() - DAY_MS;
		expect(shouldRunLogPurge(AT_2300_BANGKOK, longAgo)).toBe(true);
	});

	test("fires on a never-purged database (lastPurgeAt = 0)", () => {
		expect(shouldRunLogPurge(AT_2300_BANGKOK, 0)).toBe(true);
	});
});

describe("runLogPurge", () => {
	test("clears daily logs but retains recent audit, lane, and latency history", () => {
		const now = Date.now();
		const recent = now - 60_000;
		const expiredAudit = now - 91 * DAY_MS;

		db.run("INSERT INTO bot_events (bot_id, ts, type, message) VALUES (?, ?, ?, ?)", [1, recent, "error", "recent"]);
		db.run("INSERT INTO user_actions (user_id, username, ts, action, detail) VALUES (?, ?, ?, ?, ?)", [1, "u", recent, "login", null]);
		db.run("INSERT INTO user_actions (user_id, username, ts, action, detail) VALUES (?, ?, ?, ?, ?)", [1, "old", expiredAudit, "login", null]);
		db.run("INSERT INTO latency_samples (bot_id, ts, surface, target_mid, latency_ms, ok, source, text_preview) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [1, recent, "talk", null, 10, 1, "auto", null]);
		db.run("INSERT INTO latency_samples (bot_id, ts, surface, target_mid, latency_ms, ok, source, text_preview) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [1, now - 31 * DAY_MS, "talk", null, 99, 1, "auto", null]);
		db.run("INSERT INTO messages_in (bot_id, ts, surface, target_mid, text) VALUES (?, ?, ?, ?, ?)", [1, recent, "talk", "m1", "hello"]);
		db.run("INSERT INTO anomalies (bot_id, ts, kind, severity, detail) VALUES (?, ?, ?, ?, ?)", [1, recent, "send_dropped", "critical", "blocked"]);
		db.run("INSERT INTO lane_race_events (ts, worker_id, origin, lane_id, role, result, rtt_ms) VALUES (?, ?, ?, ?, ?, ?, ?)", [recent, "test", "https://line.test", 1, "poll", "star", 12]);
		db.run("INSERT INTO lane_race_events (ts, worker_id, origin, lane_id, role, result, rtt_ms) VALUES (?, ?, ?, ?, ?, ?, ?)", [now - 31 * DAY_MS, "test", "https://line.test", 2, "poll", "banana", 20]);

		runLogPurge(now);

		for (const table of ["bot_events", "messages_in", "anomalies"]) {
			const row = db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get();
			expect(row?.count).toBe(0);
		}
		expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM user_actions").get()?.count).toBe(1);
		expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM latency_samples").get()?.count).toBe(1);
		expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM lane_race_events").get()?.count).toBe(1);
		expect(getLastPurgeAt()).toBe(now);
	});
});
