import { describe, expect, test } from "bun:test";
import { effectiveSendSlowThresholdMs, nextSendSlowUntil, SEND_SLOW_FLOOR_MS, sendCandidatesOutsideCooldown } from "./lane-speed-policy.ts";

describe("SEND slow-lane cooldown", () => {
	test("keeps results at the 23ms boundary available and cools only results above it", () => {
		expect(nextSendSlowUntil(23, 1_000, 23, 15_000)).toBe(0);
		expect(nextSendSlowUntil(23.01, 1_000, 23, 15_000)).toBe(16_000);
	});

	test("a fast result clears an earlier cooldown immediately", () => {
		expect(nextSendSlowUntil(19.5, 9_000, 23, 15_000)).toBe(0);
	});

	test("removes cooling routes while at least one alternative exists", () => {
		const lanes = [
			{ id: 1, sendSlowUntil: 20_000 },
			{ id: 2, sendSlowUntil: 0 },
		];
		expect(sendCandidatesOutsideCooldown(lanes, 10_000).map((lane) => lane.id)).toEqual([2]);
	});

	test("falls back to every route when all are cooling instead of dropping the message", () => {
		const lanes = [
			{ id: 1, sendSlowUntil: 20_000 },
			{ id: 2, sendSlowUntil: 30_000 },
		];
		expect(sendCandidatesOutsideCooldown(lanes, 10_000)).toEqual(lanes);
	});
});

describe("effectiveSendSlowThresholdMs", () => {
	test("only the floor applies with no measured sibling", () => {
		expect(effectiveSendSlowThresholdMs(undefined)).toBe(SEND_SLOW_FLOOR_MS);
		expect(effectiveSendSlowThresholdMs(0)).toBe(SEND_SLOW_FLOOR_MS);
	});

	test("a fast pool holds its lanes to a fast bar, tighter than the floor", () => {
		// fastest 15ms -> 15 * 1.5 = 22.5, below the 28ms floor
		expect(effectiveSendSlowThresholdMs(15)).toBeCloseTo(22.5, 5);
		// a 24ms send in a 15ms pool now cools; a 24ms send with no sibling does not
		expect(nextSendSlowUntil(24, 1_000, effectiveSendSlowThresholdMs(15))).toBeGreaterThan(0);
		expect(nextSendSlowUntil(24, 1_000, effectiveSendSlowThresholdMs(undefined))).toBe(0);
	});

	test("a slow upstream (every lane slow) never pushes the threshold above the floor", () => {
		// fastest 22ms -> 22 * 1.5 = 33, capped at the 28ms floor so a 30ms lane
		// still cools rather than everything sitting just under a moving ceiling
		expect(effectiveSendSlowThresholdMs(22)).toBe(SEND_SLOW_FLOOR_MS);
		expect(nextSendSlowUntil(30, 1_000, effectiveSendSlowThresholdMs(22))).toBeGreaterThan(0);
	});
});
