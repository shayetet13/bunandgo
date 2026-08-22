import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	recordRemoteDispatchEnd,
	recordRemoteDispatchFailure,
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
		updateRemoteLaneFromReport(ORIGIN, { pingRttMs: 20 }, Date.now());
		delete process.env.LINE_RELAY_URL;
		expect(remoteLaneCandidate(ORIGIN)).toBeUndefined();
	});

	test("undefined before any report has ever arrived", () => {
		expect(remoteLaneCandidate(ORIGIN)).toBeUndefined();
	});

	test("seeds rttMs from a fresh report", () => {
		const now = 1_000_000;
		updateRemoteLaneFromReport(ORIGIN, { pingRttMs: 6.4, sendRttMs: 20.5, sendSampleAt: now }, now);
		const candidate = remoteLaneCandidate(ORIGIN, now + 1_000);
		expect(candidate?.rttMs).toBe(6.4);
		expect(candidate?.sendRttMs).toBe(20.5);
	});

	test("keeps a ping-only bootstrap distinct from a real application sample", () => {
		const now = 1_000_000;
		updateRemoteLaneFromReport(ORIGIN, { pingRttMs: 6.4 }, now);
		const candidate = remoteLaneCandidate(ORIGIN, now + 1_000);
		expect(candidate?.rttMs).toBe(6.4);
		expect(candidate?.sendRttMs).toBeUndefined();
	});

	test("undefined once the report goes stale", () => {
		const now = 1_000_000;
		updateRemoteLaneFromReport(ORIGIN, { pingRttMs: 6.4, sendRttMs: 20.5, sendSampleAt: now }, now);
		expect(remoteLaneCandidate(ORIGIN, now + 20_001)).toBeUndefined();
	});

	test("a fresh real dispatch measurement takes over from the reported estimate", () => {
		const now = Date.now();
		updateRemoteLaneFromReport(ORIGIN, { pingRttMs: 6.4, sendRttMs: 20.5, sendSampleAt: now }, now);
		recordRemoteDispatchStart(ORIGIN);
		recordRemoteDispatchEnd(ORIGIN, "send", 17.3);
		const candidate = remoteLaneCandidate(ORIGIN, now + 1_000);
		expect(candidate?.sendRttMs).toBe(17.3);
	});
});

describe("recordRemoteDispatchStart / recordRemoteDispatchEnd", () => {
	test("tracks inFlight across a dispatch", () => {
		updateRemoteLaneFromReport(ORIGIN, { pingRttMs: 6.4, sendRttMs: 20, sendSampleAt: Date.now() }, Date.now());
		recordRemoteDispatchStart(ORIGIN);
		const midFlight = remoteLaneCandidate(ORIGIN)!;
		expect(midFlight.inFlight).toBe(1);
		recordRemoteDispatchEnd(ORIGIN, "send", 18);
		expect(remoteLaneCandidate(ORIGIN)!.inFlight).toBe(0);
	});

	test("send and poll RTT are tracked separately", () => {
		recordRemoteDispatchStart(ORIGIN);
		recordRemoteDispatchEnd(ORIGIN, "send", 18);
		recordRemoteDispatchStart(ORIGIN);
		recordRemoteDispatchEnd(ORIGIN, "poll", 15);
		const candidate = remoteLaneCandidate(ORIGIN)!;
		expect(candidate.sendRttMs).toBe(18);
		expect(candidate.pollRttMs).toBe(15);
	});

	test("uses a median window so one poll spike does not replace the route score", () => {
		recordRemoteDispatchStart(ORIGIN);
		recordRemoteDispatchEnd(ORIGIN, "poll", 12);
		recordRemoteDispatchStart(ORIGIN);
		recordRemoteDispatchEnd(ORIGIN, "poll", 31);
		recordRemoteDispatchStart(ORIGIN);
		recordRemoteDispatchEnd(ORIGIN, "poll", 14);
		expect(remoteLaneCandidate(ORIGIN)!.pollRttMs).toBe(14);
	});

	test("a warm dispatch releases in-flight state without becoming a send sample", () => {
		updateRemoteLaneFromReport(ORIGIN, { pingRttMs: 8 }, Date.now());
		recordRemoteDispatchStart(ORIGIN);
		recordRemoteDispatchEnd(ORIGIN, undefined, 2);
		const candidate = remoteLaneCandidate(ORIGIN)!;
		expect(candidate.inFlight).toBe(0);
		expect(candidate.sendRttMs).toBeUndefined();
		expect(candidate.pollRttMs).toBeUndefined();
	});

	test("uses a median window so one send spike does not replace the route score", () => {
		recordRemoteDispatchStart(ORIGIN);
		recordRemoteDispatchEnd(ORIGIN, "send", 20);
		recordRemoteDispatchStart(ORIGIN);
		recordRemoteDispatchEnd(ORIGIN, "send", 80);
		recordRemoteDispatchStart(ORIGIN);
		recordRemoteDispatchEnd(ORIGIN, "send", 10);
		const candidate = remoteLaneCandidate(ORIGIN)!;
		expect(candidate.sendRttMs).toBe(20);
	});

	test("a failed dispatch releases inFlight without becoming a latency sample", () => {
		updateRemoteLaneFromReport(ORIGIN, { pingRttMs: 8 }, Date.now());
		recordRemoteDispatchStart(ORIGIN);
		recordRemoteDispatchFailure(ORIGIN);
		const candidate = remoteLaneCandidate(ORIGIN)!;
		expect(candidate.inFlight).toBe(0);
		expect(candidate.sendRttMs).toBeUndefined();
	});

	test("inFlight never goes negative from an unmatched end", () => {
		recordRemoteDispatchEnd(ORIGIN, "send", 18);
		recordRemoteDispatchEnd(ORIGIN, "send", 18);
		expect(remoteLaneCandidate(ORIGIN)!.inFlight).toBe(0);
	});
});
