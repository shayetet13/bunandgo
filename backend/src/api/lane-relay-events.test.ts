import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { LaneStat, LaneRaceLaneView } from "../dispatch/h2-lanes.ts";
import { remoteLaneCandidate, resetRemoteLaneStateForTest } from "../dispatch/remote-lane.ts";
import {
	LANE_RELAY_TOKEN_HEADER,
	MAX_TRACKED_WORKERS,
	laneRelayEventsRoute,
	remoteLaneRaces,
	remoteLaneStats,
	resetLaneRelayReportsForTest,
} from "./lane-relay-events.ts";

const originalToken = process.env.LANE_RELAY_TOKEN;
const originalRelayUrl = process.env.LINE_RELAY_URL;
const originalRelayToken = process.env.LINE_RELAY_TOKEN;
const FIXTURE_TS = Date.now();

afterEach(() => {
	if (originalToken === undefined) delete process.env.LANE_RELAY_TOKEN;
	else process.env.LANE_RELAY_TOKEN = originalToken;
	if (originalRelayUrl === undefined) delete process.env.LINE_RELAY_URL;
	else process.env.LINE_RELAY_URL = originalRelayUrl;
	if (originalRelayToken === undefined) delete process.env.LINE_RELAY_TOKEN;
	else process.env.LINE_RELAY_TOKEN = originalRelayToken;
	resetLaneRelayReportsForTest();
	resetRemoteLaneStateForTest();
});

function buildApp(): Hono {
	const app = new Hono();
	app.route("/internal/lane-relay-events", laneRelayEventsRoute);
	return app;
}

function fixtureLane(): LaneStat {
	return {
		origin: "https://legy.line-apps.com",
		id: 0,
		state: "ready",
		inFlight: 0,
		lastOkAt: FIXTURE_TS,
		lastSendOkAt: FIXTURE_TS,
		lastPollOkAt: FIXTURE_TS,
		applicationRttMs: 15.2,
		applicationSampleAt: FIXTURE_TS,
		routingEligible: true,
		consecutiveFailures: 0,
		openedAt: FIXTURE_TS - 500,
	};
}

function fixtureScore() {
	return { samples: 3, stars: 2, bananas: 1, bigStars: 0 };
}

function fixtureRace(): LaneRaceLaneView {
	return {
		origin: "https://legy.line-apps.com",
		laneId: 0,
		state: "ready",
		inFlight: 0,
		applicationRttMs: 15.2,
		applicationSampleAt: FIXTURE_TS,
		routingEligible: true,
		send: fixtureScore(),
		poll: fixtureScore(),
	};
}

function reportBody(workerId: string) {
	return {
		workerId,
		ts: FIXTURE_TS,
		lanes: [fixtureLane()],
		races: [fixtureRace()],
	};
}

describe("lane relay report intake", () => {
	test("503s when no LANE_RELAY_TOKEN is configured", async () => {
		delete process.env.LANE_RELAY_TOKEN;
		const app = buildApp();
		const response = await app.request("/internal/lane-relay-events", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(reportBody("relay-3")),
		});
		expect(response.status).toBe(503);
	});

	test("rejects a report with the wrong token", async () => {
		process.env.LANE_RELAY_TOKEN = "correct-token";
		const app = buildApp();
		const response = await app.request("/internal/lane-relay-events", {
			method: "POST",
			headers: { "content-type": "application/json", [LANE_RELAY_TOKEN_HEADER]: "wrong-token" },
			body: JSON.stringify(reportBody("relay-3")),
		});
		expect(response.status).toBe(403);
		expect(remoteLaneStats()).toEqual([]);
	});

	test("rejects a malformed body", async () => {
		process.env.LANE_RELAY_TOKEN = "correct-token";
		const app = buildApp();
		const response = await app.request("/internal/lane-relay-events", {
			method: "POST",
			headers: { "content-type": "application/json", [LANE_RELAY_TOKEN_HEADER]: "correct-token" },
			body: JSON.stringify({ workerId: "relay-3" }),
		});
		expect(response.status).toBe(400);
	});

	test("accepts a valid report and tags every lane/race with its workerId", async () => {
		process.env.LANE_RELAY_TOKEN = "correct-token";
		const app = buildApp();
		const response = await app.request("/internal/lane-relay-events", {
			method: "POST",
			headers: { "content-type": "application/json", [LANE_RELAY_TOKEN_HEADER]: "correct-token" },
			body: JSON.stringify(reportBody("relay-3")),
		});
		expect(response.status).toBe(202);
		expect(remoteLaneStats()).toEqual([{ ...fixtureLane(), workerId: "relay-3" }]);
		expect(remoteLaneRaces()).toEqual([{ ...fixtureRace(), workerId: "relay-3" }]);
	});

	test("seeds the remote candidate from PING rttMs when no lane has an application sample yet", async () => {
		process.env.LANE_RELAY_TOKEN = "correct-token";
		process.env.LINE_RELAY_URL = "http://10.90.0.2:8795/dispatch";
		process.env.LINE_RELAY_TOKEN = "dispatch-token";
		const app = buildApp();
		const neverUsedLane: LaneStat = {
			...fixtureLane(),
			applicationRttMs: undefined,
			applicationSampleAt: 0,
			routingEligible: false,
			rttMs: 6.4,
		};
		const response = await app.request("/internal/lane-relay-events", {
			method: "POST",
			headers: { "content-type": "application/json", [LANE_RELAY_TOKEN_HEADER]: "correct-token" },
			body: JSON.stringify({ workerId: "relay-3", ts: Date.now(), lanes: [neverUsedLane], races: [] }),
		});
		expect(response.status).toBe(202);
		// A brand-new relay box with zero real dispatches ever must still be
		// able to seed a candidate — otherwise it could never be picked for
		// its first one, since eligibility depends on this exact value.
		expect(remoteLaneCandidate("https://legy.line-apps.com")?.rttMs).toBe(6.4);
	});

	test("prefers a real applicationRttMs over another lane's ping-only rttMs on the same origin", async () => {
		process.env.LANE_RELAY_TOKEN = "correct-token";
		process.env.LINE_RELAY_URL = "http://10.90.0.2:8795/dispatch";
		process.env.LINE_RELAY_TOKEN = "dispatch-token";
		const app = buildApp();
		const neverUsedLane: LaneStat = {
			...fixtureLane(),
			id: 1,
			applicationRttMs: undefined,
			applicationSampleAt: 0,
			routingEligible: false,
			rttMs: 1.2,
		};
		const provenLane: LaneStat = { ...fixtureLane(), id: 2, applicationRttMs: 18.5 };
		const response = await app.request("/internal/lane-relay-events", {
			method: "POST",
			headers: { "content-type": "application/json", [LANE_RELAY_TOKEN_HEADER]: "correct-token" },
			body: JSON.stringify({ workerId: "relay-3", ts: Date.now(), lanes: [neverUsedLane, provenLane], races: [] }),
		});
		expect(response.status).toBe(202);
		// The proven 18.5ms real sample must win over the other lane's
		// optimistic 1.2ms ping-only number — once an origin has real
		// traffic anywhere on the box, an unused lane elsewhere must not
		// make it look faster than it actually performs.
		expect(remoteLaneCandidate("https://legy.line-apps.com")?.rttMs).toBe(18.5);
	});

	test("does not refresh an expired application sample by repeating it in a fresh report", async () => {
		process.env.LANE_RELAY_TOKEN = "correct-token";
		process.env.LINE_RELAY_URL = "http://10.90.0.2:8795/dispatch";
		process.env.LINE_RELAY_TOKEN = "dispatch-token";
		const app = buildApp();
		const staleLane: LaneStat = {
			...fixtureLane(),
			applicationRttMs: 5,
			applicationSampleAt: FIXTURE_TS - 60_000,
			rttMs: 8,
		};
		const response = await app.request("/internal/lane-relay-events", {
			method: "POST",
			headers: { "content-type": "application/json", [LANE_RELAY_TOKEN_HEADER]: "correct-token" },
			body: JSON.stringify({ workerId: "relay-3", ts: FIXTURE_TS, lanes: [staleLane], races: [] }),
		});
		expect(response.status).toBe(202);
		expect(remoteLaneCandidate("https://legy.line-apps.com")?.rttMs).toBe(8);
	});

	test("drops a report once it is older than the requested max age", async () => {
		process.env.LANE_RELAY_TOKEN = "correct-token";
		const app = buildApp();
		await app.request("/internal/lane-relay-events", {
			method: "POST",
			headers: { "content-type": "application/json", [LANE_RELAY_TOKEN_HEADER]: "correct-token" },
			body: JSON.stringify(reportBody("relay-3")),
		});
		expect(remoteLaneStats(60_000).length).toBe(1);
		// -1 forces "stale" deterministically instead of racing real elapsed
		// time against maxAgeMs=0, which can flake when the report and the
		// read land in the same millisecond.
		expect(remoteLaneStats(-1)).toEqual([]);
	});

	test("caps the number of distinct workers it will track", async () => {
		process.env.LANE_RELAY_TOKEN = "correct-token";
		const app = buildApp();
		for (let i = 0; i < MAX_TRACKED_WORKERS; i++) {
			const response = await app.request("/internal/lane-relay-events", {
				method: "POST",
				headers: { "content-type": "application/json", [LANE_RELAY_TOKEN_HEADER]: "correct-token" },
				body: JSON.stringify(reportBody(`relay-${i}`)),
			});
			expect(response.status).toBe(202);
		}
		const overflow = await app.request("/internal/lane-relay-events", {
			method: "POST",
			headers: { "content-type": "application/json", [LANE_RELAY_TOKEN_HEADER]: "correct-token" },
			body: JSON.stringify(reportBody("one-too-many")),
		});
		expect(overflow.status).toBe(429);

		// A repeat report from an already-tracked worker must still go through —
		// the cap is on distinct workers, not total reports.
		const repeat = await app.request("/internal/lane-relay-events", {
			method: "POST",
			headers: { "content-type": "application/json", [LANE_RELAY_TOKEN_HEADER]: "correct-token" },
			body: JSON.stringify(reportBody("relay-0")),
		});
		expect(repeat.status).toBe(202);
	});
});
