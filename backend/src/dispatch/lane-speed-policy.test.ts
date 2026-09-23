import { describe, expect, test } from "bun:test";
import {
	effectiveSendSlowThresholdMs,
	holdsSendPin,
	nextSendSlowUntil,
	qualifiesForSendPin,
	SEND_PIN_ENTER_MS,
	SEND_PIN_EXIT_MS,
	SEND_SLOW_FLOOR_MS,
	sendCandidatesOutsideCooldown,
} from "./lane-speed-policy.ts";

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
		// fastest 12ms -> 12 * 1.5 = 18, below the floor
		expect(effectiveSendSlowThresholdMs(12)).toBeCloseTo(18, 5);
		// a 20ms send in a 12ms pool cools; the same send with no sibling does not
		expect(nextSendSlowUntil(20, 1_000, effectiveSendSlowThresholdMs(12))).toBeGreaterThan(0);
		expect(nextSendSlowUntil(20, 1_000, effectiveSendSlowThresholdMs(undefined))).toBe(0);
	});

	test("a slow upstream (every lane slow) never pushes the threshold above the floor", () => {
		// fastest 22ms -> 22 * 1.5 = 33, capped at the floor so a 30ms lane
		// still cools rather than everything sitting just under a moving ceiling
		expect(effectiveSendSlowThresholdMs(22)).toBe(SEND_SLOW_FLOOR_MS);
		expect(nextSendSlowUntil(30, 1_000, effectiveSendSlowThresholdMs(22))).toBeGreaterThan(0);
	});

	test("cools the measured production tail but leaves the median in rotation", () => {
		// Server 2, 7 days, n=1040: p50 19.9, p90 25.2, p95 33.7. The floor has
		// to sit above the median with real margin or nearly every send cools
		// and the ranking collapses into fail-open — confirmed live on
		// 2026-08-31 when a 20ms floor (barely above that median) started
		// cooling most sends within an hour of live traffic.
		expect(SEND_SLOW_FLOOR_MS).toBeGreaterThan(19.9);
		const slowestSiblingMedian = 23.3; // the slowest of the eight real send lanes
		const threshold = effectiveSendSlowThresholdMs(18.2); // the fastest one
		expect(nextSendSlowUntil(19.9, 1_000, threshold)).toBe(0); // median stays available
		expect(nextSendSlowUntil(25.2, 1_000, threshold)).toBeGreaterThan(0); // p90 cools
		expect(nextSendSlowUntil(slowestSiblingMedian, 1_000, threshold)).toBeGreaterThan(0);
	});
});

describe("SEND lane pin hysteresis", () => {
	test("exit never sits below enter, even under a misconfigured env override", () => {
		expect(SEND_PIN_EXIT_MS).toBeGreaterThanOrEqual(SEND_PIN_ENTER_MS);
	});

	test("a lane must beat the enter line to newly qualify for the pin", () => {
		expect(qualifiesForSendPin(SEND_PIN_ENTER_MS - 0.01)).toBeTrue();
		expect(qualifiesForSendPin(SEND_PIN_ENTER_MS)).toBeFalse();
		expect(qualifiesForSendPin(SEND_PIN_ENTER_MS + 1)).toBeFalse();
	});

	test("a held pin survives up to, but not including, the exit line", () => {
		expect(holdsSendPin(SEND_PIN_EXIT_MS - 0.01)).toBeTrue();
		expect(holdsSendPin(SEND_PIN_EXIT_MS)).toBeFalse();
		expect(holdsSendPin(SEND_PIN_EXIT_MS + 1)).toBeFalse();
	});

	test("the enter/exit gap gives a proven lane room to hold through ordinary jitter", () => {
		// 21ms to qualify, 23ms to release (matching SEND_SLOW_FLOOR_MS): a
		// lane sitting at the 19.9ms production median keeps its pin instead
		// of flapping every send, and so does one drifting a couple ms above it.
		expect(SEND_PIN_ENTER_MS).toBe(21);
		expect(SEND_PIN_EXIT_MS).toBe(23);
		expect(holdsSendPin(19.9)).toBeTrue();
		expect(holdsSendPin(22.5)).toBeTrue();
	});
});
