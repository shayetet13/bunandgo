import { describe, expect, test } from "bun:test";
import {
	freshSendRouteProfile,
	getOrCreateSendRouteProfile,
	percentile,
	predictSendCompletion,
	recordSendRouteSample,
	type SendRouteProfile,
} from "./send-prediction.ts";

describe("SEND completion prediction", () => {
	test("uses p50 plus observed jitter instead of trusting a deceptively fast median", () => {
		const unstable = predictSendCompletion([15, 15, 16, 15, 48], undefined, 0, 100);
		const stable = predictSendCompletion([17, 17, 18, 17, 18], undefined, 0, 100);
		expect(unstable?.p50Ms).toBe(15);
		expect(unstable?.p95Ms).toBe(48);
		expect(unstable!.predictedMs).toBeGreaterThan(stable!.predictedMs);
	});

	test("adds queue time only when the peer-advertised stream capacity is occupied", () => {
		expect(predictSendCompletion([15], undefined, 1, 2)?.queueMs).toBe(0);
		expect(predictSendCompletion([15], undefined, 2, 2)?.queueMs).toBe(15);
		expect(predictSendCompletion([15], undefined, 4, 2)?.queueMs).toBe(30);
	});

	test("calculates nearest-rank percentiles deterministically", () => {
		expect(percentile([30, 10, 20], 0.5)).toBe(20);
		expect(percentile([30, 10, 20], 0.95)).toBe(30);
	});
});

describe("per-bot SEND profiles", () => {
	test("keeps a slow bot-specific route separate and expires stale history", () => {
		const profiles = new Map<string, SendRouteProfile>();
		const profile = getOrCreateSendRouteProfile(profiles, "bot-12");
		recordSendRouteSample(profile, 28, 1_000_000);
		expect(freshSendRouteProfile(profiles, "bot-12", 1_001_000)?.slowUntil).toBeGreaterThan(1_000_000);
		expect(freshSendRouteProfile(profiles, "another-bot", 1_001_000)).toBeUndefined();
		expect(freshSendRouteProfile(profiles, "bot-12", 1_100_000)).toBeUndefined();
	});

	test("a fast result immediately clears that bot's cooldown", () => {
		const profile: SendRouteProfile = { samples: [], lastAt: 0, slowUntil: 0 };
		recordSendRouteSample(profile, 40, 1_000);
		expect(profile.slowUntil).toBeGreaterThan(1_000);
		recordSendRouteSample(profile, 18, 2_000);
		expect(profile.slowUntil).toBe(0);
	});
});
