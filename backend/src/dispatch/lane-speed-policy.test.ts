import { describe, expect, test } from "bun:test";
import { nextSendSlowUntil, sendCandidatesOutsideCooldown } from "./lane-speed-policy.ts";

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
