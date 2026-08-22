import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	recordRemoteDispatchEnd,
	recordRemoteDispatchStart,
	remoteDispatchConfig,
	remoteLaneCandidate,
	resetRemoteLaneStateForTest,
	updateRemoteLaneFromReport,
} from "./remote-lane.ts";

const ORIGIN = "https://legy.line-apps.com";
const originalUrl = process.env.LINE_RELAY_URL;
const originalToken = process.env.LINE_RELAY_TOKEN;

beforeEach(() => {
	process.env.LINE_RELAY_URL = "http://10.90.0.2:8795/dispatch";
	process.env.LINE_RELAY_TOKEN = "test-token";
});

afterEach(() => {
	resetRemoteLaneStateForTest();
	if (originalUrl === undefined) delete process.env.LINE_RELAY_URL;
	else process.env.LINE_RELAY_URL = originalUrl;
	if (originalToken === undefined) delete process.env.LINE_RELAY_TOKEN;
	else process.env.LINE_RELAY_TOKEN = originalToken;
});

describe("remoteDispatchConfig", () => {
	test("undefined when either env var is missing", () => {
		delete process.env.LINE_RELAY_TOKEN;
		expect(remoteDispatchConfig()).toBeUndefined();
	});

	test("present when both env vars are set", () => {
		expect(remoteDispatchConfig()).toEqual({ url: "http://10.90.0.2:8795/dispatch", token: "test-token" });
	});
});

describe("remoteLaneCandidate", () => {
	test("undefined when the relay isn't configured, even with a fresh report", () => {
		updateRemoteLaneFromReport(ORIGIN, 20, Date.now());
		delete process.env.LINE_RELAY_URL;
		expect(remoteLaneCandidate(ORIGIN)).toBeUndefined();
	});

	test("undefined before any report has ever arrived", () => {
		expect(remoteLaneCandidate(ORIGIN)).toBeUndefined();
	});

	test("seeds rttMs from a fresh report", () => {
		const now = 1_000_000;
		updateRemoteLaneFromReport(ORIGIN, 20.5, now);
		const candidate = remoteLaneCandidate(ORIGIN, now + 1_000);
		expect(candidate?.rttMs).toBe(20.5);
	});

	test("undefined once the report goes stale", () => {
		const now = 1_000_000;
		updateRemoteLaneFromReport(ORIGIN, 20.5, now);
		expect(remoteLaneCandidate(ORIGIN, now + 20_001)).toBeUndefined();
	});

	test("a real dispatch measurement takes over from the reported estimate", () => {
		const now = 1_000_000;
		updateRemoteLaneFromReport(ORIGIN, 20.5, now);
		recordRemoteDispatchStart(ORIGIN);
		recordRemoteDispatchEnd(ORIGIN, "send", 17.3, 21);
		// Even far past the report's staleness window, the real measurement
		// keeps the candidate alive — it no longer depends on the report at all.
		const candidate = remoteLaneCandidate(ORIGIN, now + 60_000);
		expect(candidate?.sendRttMs).toBe(17.3);
	});
});

describe("recordRemoteDispatchStart / recordRemoteDispatchEnd", () => {
	test("tracks inFlight across a dispatch", () => {
		updateRemoteLaneFromReport(ORIGIN, 20, Date.now());
		recordRemoteDispatchStart(ORIGIN);
		const midFlight = remoteLaneCandidate(ORIGIN)!;
		expect(midFlight.inFlight).toBe(1);
		recordRemoteDispatchEnd(ORIGIN, "send", 18, 21);
		expect(remoteLaneCandidate(ORIGIN)!.inFlight).toBe(0);
	});

	test("send and poll RTT are tracked separately", () => {
		recordRemoteDispatchStart(ORIGIN);
		recordRemoteDispatchEnd(ORIGIN, "send", 18, 21);
		recordRemoteDispatchStart(ORIGIN);
		recordRemoteDispatchEnd(ORIGIN, "poll", 15, 21);
		const candidate = remoteLaneCandidate(ORIGIN)!;
		expect(candidate.sendRttMs).toBe(18);
		expect(candidate.pollRttMs).toBe(15);
	});

	test("smooths repeated samples with an EWMA instead of overwriting", () => {
		recordRemoteDispatchStart(ORIGIN);
		recordRemoteDispatchEnd(ORIGIN, "send", 20, 21);
		recordRemoteDispatchStart(ORIGIN);
		recordRemoteDispatchEnd(ORIGIN, "send", 10, 21);
		const candidate = remoteLaneCandidate(ORIGIN)!;
		// 20 * 0.65 + 10 * 0.35 = 16.5 — a single fast sample must not fully
		// override an established baseline.
		expect(candidate.sendRttMs).toBeCloseTo(16.5, 5);
	});

	test("consecutive-slow counter increments at/above the discard ceiling and resets on a fast sample", () => {
		recordRemoteDispatchStart(ORIGIN);
		recordRemoteDispatchEnd(ORIGIN, "send", 25, 21);
		recordRemoteDispatchStart(ORIGIN);
		recordRemoteDispatchEnd(ORIGIN, "send", 30, 21);
		let candidate = remoteLaneCandidate(ORIGIN)!;
		expect(candidate.consecutiveSlowApplicationSamples).toBe(2);

		recordRemoteDispatchStart(ORIGIN);
		recordRemoteDispatchEnd(ORIGIN, "send", 15, 21);
		candidate = remoteLaneCandidate(ORIGIN)!;
		expect(candidate.consecutiveSlowApplicationSamples).toBe(0);
	});

	test("inFlight never goes negative from an unmatched end", () => {
		recordRemoteDispatchEnd(ORIGIN, "send", 18, 21);
		recordRemoteDispatchEnd(ORIGIN, "send", 18, 21);
		expect(remoteLaneCandidate(ORIGIN)!.inFlight).toBe(0);
	});
});
