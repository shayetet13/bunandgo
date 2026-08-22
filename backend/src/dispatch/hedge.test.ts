import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../db/sqlite.ts";
import {
	analyzeSendSamples,
	applyHedgeConfig,
	hedgeConfig,
	hedgeShadowReport,
	parseHedgeConfig,
	percentile,
	refreshHedgeConfig,
	type HedgeConfig,
} from "./hedge.ts";

const SHADOW: HedgeConfig = { mode: "shadow", delayMs: 14, slowMs: 23 };

beforeEach(() => {
	db.prepare("DELETE FROM lane_race_events").run();
	db.prepare("DELETE FROM app_meta WHERE key = 'hedge.send.config'").run();
	refreshHedgeConfig();
});

describe("parseHedgeConfig", () => {
	test("accepts a valid shadow config", () => {
		expect(parseHedgeConfig({ mode: "shadow", delayMs: 14, slowMs: 23 })).toEqual(SHADOW);
	});

	test("accepts off and coerces numeric strings", () => {
		expect(parseHedgeConfig({ mode: "off", delayMs: "10", slowMs: "30" })).toEqual({ mode: "off", delayMs: 10, slowMs: 30 });
	});

	test("rejects mode on until stage 2 proves reqSeq dedupe", () => {
		expect(() => parseHedgeConfig({ mode: "on", delayMs: 14, slowMs: 23 })).toThrow(/stage 2/);
	});

	test("rejects unknown modes and malformed payloads", () => {
		expect(() => parseHedgeConfig({ mode: "fast", delayMs: 14, slowMs: 23 })).toThrow();
		expect(() => parseHedgeConfig(undefined)).toThrow();
		expect(() => parseHedgeConfig("shadow")).toThrow();
	});

	test("rejects out-of-range timings and delay at or above slow", () => {
		expect(() => parseHedgeConfig({ mode: "shadow", delayMs: 4, slowMs: 23 })).toThrow();
		expect(() => parseHedgeConfig({ mode: "shadow", delayMs: 41, slowMs: 60 })).toThrow();
		expect(() => parseHedgeConfig({ mode: "shadow", delayMs: 14, slowMs: 9 })).toThrow();
		expect(() => parseHedgeConfig({ mode: "shadow", delayMs: 14, slowMs: 101 })).toThrow();
		expect(() => parseHedgeConfig({ mode: "shadow", delayMs: 23, slowMs: 23 })).toThrow();
	});
});

describe("percentile", () => {
	test("returns undefined on empty input", () => {
		expect(percentile([], 99)).toBeUndefined();
	});

	test("picks the nearest-rank value", () => {
		const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		expect(percentile(values, 50)).toBe(5);
		expect(percentile(values, 95)).toBe(10);
		expect(percentile(values, 99)).toBe(10);
		expect(percentile([7], 50)).toBe(7);
	});
});

describe("analyzeSendSamples", () => {
	function sample(workerId: string, laneId: number, rttMs: number) {
		return { workerId, origin: "https://legy.line-apps.com", laneId, rttMs };
	}

	test("splits by worker and counts hedge fires and slow sends", () => {
		const samples = [
			// worker a: 8 fast sends, one 18ms (fires hedge, not slow), one 80ms spike.
			...Array.from({ length: 8 }, () => sample("a", 0, 12)),
			sample("a", 1, 18),
			sample("a", 1, 80),
			// worker b: entirely fast.
			...Array.from({ length: 5 }, () => sample("b", 0, 11)),
		];
		const [a, b] = analyzeSendSamples(samples, SHADOW);

		expect(a!.workerId).toBe("a");
		expect(a!.samples).toBe(10);
		expect(a!.wouldFireCount).toBe(2);
		expect(a!.wouldFirePct).toBe(20);
		expect(a!.slowCount).toBe(1);
		expect(a!.slowPct).toBe(10);
		expect(a!.projectedSlowPctIfIndependent).toBeCloseTo(1, 5);
		expect(a!.maxMs).toBe(80);
		// The lane carrying the spike sorts first for triage.
		expect(a!.lanes[0]!.laneId).toBe(1);
		expect(a!.lanes[0]!.slowCount).toBe(1);

		expect(b!.workerId).toBe("b");
		expect(b!.samples).toBe(5);
		expect(b!.wouldFireCount).toBe(0);
		expect(b!.slowCount).toBe(0);
		expect(b!.projectedSlowPctIfIndependent).toBe(0);
	});

	test("returns an empty list when there are no samples", () => {
		expect(analyzeSendSamples([], SHADOW)).toEqual([]);
	});
});

describe("hedge config persistence", () => {
	test("applyHedgeConfig persists and refresh reloads it", () => {
		applyHedgeConfig(SHADOW);
		expect(hedgeConfig()).toEqual(SHADOW);
		expect(refreshHedgeConfig()).toEqual(SHADOW);
	});

	test("a corrupted persisted row falls back to safe defaults", () => {
		applyHedgeConfig(SHADOW);
		db.prepare("UPDATE app_meta SET value = 'not-json' WHERE key = 'hedge.send.config'").run();
		expect(refreshHedgeConfig().mode).toBe("off");
	});

	test("a persisted row that fails validation falls back to safe defaults", () => {
		db.prepare("INSERT INTO app_meta (key, value) VALUES ('hedge.send.config', ?)").run(
			JSON.stringify({ mode: "on", delayMs: 14, slowMs: 23 }),
		);
		expect(refreshHedgeConfig().mode).toBe("off");
	});
});

describe("hedgeShadowReport", () => {
	const insertEvent = db.prepare<null, [number, string, string, number, string, string, number]>(
		"INSERT INTO lane_race_events (ts, worker_id, origin, lane_id, role, result, rtt_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);

	test("reads only send events inside the window", () => {
		const now = Date.now();
		const origin = "https://legy.line-apps.com";
		insertEvent.run(now - 1_000, "w1", origin, 0, "send", "star", 12);
		insertEvent.run(now - 2_000, "w1", origin, 1, "send", "banana", 80);
		// Excluded: a poll event and a send outside the window.
		insertEvent.run(now - 3_000, "w1", origin, 2, "poll", "star", 15);
		insertEvent.run(now - 2 * 60 * 60 * 1000, "w1", origin, 0, "send", "star", 12);

		const report = hedgeShadowReport(1, now);
		expect(report.windowHours).toBe(1);
		expect(report.totalSamples).toBe(2);
		expect(report.workers).toHaveLength(1);
		expect(report.workers[0]!.slowCount).toBe(1);
		expect(report.workers[0]!.maxMs).toBe(80);
	});

	test("clamps the requested window and reports the active config", () => {
		applyHedgeConfig(SHADOW);
		const report = hedgeShadowReport(9_999);
		expect(report.windowHours).toBe(168);
		expect(report.config).toEqual(SHADOW);
		expect(report.totalSamples).toBe(0);
		expect(report.workers).toEqual([]);
	});
});
