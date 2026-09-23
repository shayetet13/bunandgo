import { describe, expect, test } from "bun:test";
import {
	freshSendRouteProfile,
	getOrCreateSendRouteProfile,
	percentile,
	predictSendCompletion,
	predictSendRouteCompletion,
	recordSendRouteSample,
	summarizeSendSamples,
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

	test("caches distribution statistics when a route sample arrives", () => {
		const profile: SendRouteProfile = { samples: [], lastAt: 0, slowUntil: 0 };
		recordSendRouteSample(profile, 15, 1_000);
		recordSendRouteSample(profile, 48, 1_001);
		expect(profile).toMatchObject({ p50Ms: 15, p95Ms: 48, jitterMs: 33 });
		expect(predictSendRouteCompletion(profile, 0, 100)?.predictedMs).toBeGreaterThan(15);
		expect(summarizeSendSamples([30, 10, 20])).toMatchObject({ p50Ms: 20, p95Ms: 30, jitterMs: 10 });
	});
});

describe("per-bot SEND profiles", () => {
	test("keeps a slow bot-specific route separate and expires stale history", () => {
		const profiles = new Map<string, SendRouteProfile>();
		const profile = getOrCreateSendRouteProfile(profiles, "bot-12");
		recordSendRouteSample(profile, 40, 1_000_000);
		expect(freshSendRouteProfile(profiles, "bot-12", 1_001_000)?.slowUntil).toBeGreaterThan(1_000_000);
		expect(freshSendRouteProfile(profiles, "another-bot", 1_001_000)).toBeUndefined();
		// Fresh within the 15-minute route window, stale past it.
		expect(freshSendRouteProfile(profiles, "bot-12", 1_000_000 + 899_000)).toBeDefined();
		expect(freshSendRouteProfile(profiles, "bot-12", 1_000_000 + 901_000)).toBeUndefined();
	});

	test("a fast result immediately clears that bot's cooldown", () => {
		const profile: SendRouteProfile = { samples: [], lastAt: 0, slowUntil: 0 };
		recordSendRouteSample(profile, 40, 1_000);
		expect(profile.slowUntil).toBeGreaterThan(1_000);
		recordSendRouteSample(profile, 18, 2_000);
		expect(profile.slowUntil).toBe(0);
	});
});
