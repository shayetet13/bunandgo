import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../db/sqlite.ts";
import { clearBotAnomalies, listAnomalies, summarizeAnomalies } from "./anomalies.ts";
import type { AnomalySeverity } from "../db/schema.ts";

/**
 * Inserts directly rather than through `recordAnomaly`, whose whole point is
 * to hand the write to a background worker — a test that waited on that
 * would be testing the worker's flush timer, not the query layer the
 * dashboard actually reads through.
 */
function seed(row: { botId: number | null; ts: number; kind: string; severity: AnomalySeverity; chatMid?: string; detail?: string }): void {
	db.query("INSERT INTO anomalies (bot_id, ts, kind, severity, chat_mid, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").run(
		row.botId,
		row.ts,
		row.kind,
		row.severity,
		row.chatMid ?? null,
		row.detail ?? null,
	);
}

const NOW = 1_800_000_000_000;

describe("anomalies", () => {
	beforeEach(() => {
		db.query("DELETE FROM anomalies").run();
	});

	test("returns rows newest first", () => {
		seed({ botId: 1, ts: NOW - 3000, kind: "reply_destroyed", severity: "critical" });
		seed({ botId: 1, ts: NOW - 1000, kind: "reply_resent", severity: "warn" });
		seed({ botId: 1, ts: NOW - 2000, kind: "send_dropped", severity: "warn" });

		expect(listAnomalies().map((row) => row.kind)).toEqual(["reply_resent", "send_dropped", "reply_destroyed"]);
	});

	test("filters by bot, kind, and severity independently", () => {
		seed({ botId: 1, ts: NOW, kind: "reply_destroyed", severity: "critical" });
		seed({ botId: 2, ts: NOW, kind: "reply_destroyed", severity: "critical" });
		seed({ botId: 1, ts: NOW, kind: "send_dropped", severity: "warn" });

		expect(listAnomalies({ botId: 1 })).toHaveLength(2);
		expect(listAnomalies({ kind: "reply_destroyed" })).toHaveLength(2);
		expect(listAnomalies({ severity: "warn" })).toHaveLength(1);
		expect(listAnomalies({ botId: 1, kind: "reply_destroyed" })).toHaveLength(1);
	});

	test("excludes rows older than the since bound", () => {
		seed({ botId: 1, ts: NOW - 10_000, kind: "reply_destroyed", severity: "critical" });
		seed({ botId: 1, ts: NOW, kind: "reply_destroyed", severity: "critical" });

		expect(listAnomalies({ since: NOW - 5_000 })).toHaveLength(1);
	});

	test("caps the limit so a crafted request cannot dump the table", () => {
		for (let i = 0; i < 12; i++) seed({ botId: 1, ts: NOW - i, kind: "send_dropped", severity: "warn" });

		expect(listAnomalies({ limit: 5 })).toHaveLength(5);
		expect(listAnomalies({ limit: 10_000 }).length).toBeLessThanOrEqual(500);
	});

	test("keeps the chat a row happened in", () => {
		seed({ botId: 1, ts: NOW, kind: "reply_invisible", severity: "critical", chatMid: "sq-room", detail: "หาย" });

		const [row] = listAnomalies();
		expect(row!.chat_mid).toBe("sq-room");
		expect(row!.detail).toBe("หาย");
	});

	test("summarizes counts per kind within the window", () => {
		seed({ botId: 1, ts: NOW, kind: "reply_destroyed", severity: "critical" });
		seed({ botId: 1, ts: NOW, kind: "reply_destroyed", severity: "critical" });
		seed({ botId: 1, ts: NOW, kind: "send_dropped", severity: "warn" });
		seed({ botId: 1, ts: NOW - 100_000, kind: "send_failed", severity: "critical" });

		const summary = summarizeAnomalies(NOW - 50_000);

		expect(summary.find((row) => row.kind === "reply_destroyed")?.count).toBe(2);
		expect(summary.find((row) => row.kind === "send_dropped")?.count).toBe(1);
		expect(summary.find((row) => row.kind === "send_failed")).toBeUndefined();
	});

	test("summary can be scoped to one bot", () => {
		seed({ botId: 1, ts: NOW, kind: "reply_destroyed", severity: "critical" });
		seed({ botId: 2, ts: NOW, kind: "reply_destroyed", severity: "critical" });

		expect(summarizeAnomalies(NOW - 1000, 1).find((row) => row.kind === "reply_destroyed")?.count).toBe(1);
	});

	test("clearBotAnomalies drops only that bot's history", () => {
		seed({ botId: 1, ts: NOW, kind: "reply_destroyed", severity: "critical" });
		seed({ botId: 2, ts: NOW, kind: "reply_destroyed", severity: "critical" });

		clearBotAnomalies(1);

		expect(listAnomalies().map((row) => row.bot_id)).toEqual([2]);
	});
});
