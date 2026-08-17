import { describe, expect, test } from "bun:test";
import type { LatencySample } from "./types.ts";
import { buildRaceCommentary, raceTone } from "./race-commentary.ts";

function sample(latencyMs: number, ok = true, ts = 1, source: LatencySample["source"] = "auto"): LatencySample {
	return { botId: 7, ts, surface: "square", targetMid: "room", latencyMs, ok, source, textPreview: "test" };
}

describe("full-troll race commentary", () => {
	test("classifies the 23ms target without claiming a real competitor rank", () => {
		expect(raceTone(sample(14.9))).toBe("blitz");
		expect(raceTone(sample(22.9))).toBe("fast");
		expect(raceTone(sample(23))).toBe("late");
		expect(raceTone(sample(10, false))).toBe("failed");
	});

	test("builds streak, hit rate, and recent form from auto replies only", () => {
		const result = buildRaceCommentary([sample(18, true, 4), sample(20, true, 3), sample(40, true, 2, "test"), sample(27, true, 1)]);

		expect(result.streakLabel).toContain("2 รอบ");
		expect(result.hits).toBe(2);
		expect(result.total).toBe(3);
		expect(result.hitRate).toBe(67);
		expect(result.recent).toEqual(["fast", "fast", "late"]);
	});

	test("returns calm empty state before the first automatic reply", () => {
		const result = buildRaceCommentary([sample(12, true, 1, "test")]);
		expect(result.tone).toBe("idle");
		expect(result.total).toBe(0);
	});
});
