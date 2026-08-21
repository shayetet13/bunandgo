import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { LaneStat, LaneRaceLaneView } from "../dispatch/h2-lanes.ts";
import {
	LANE_RELAY_TOKEN_HEADER,
	MAX_TRACKED_WORKERS,
	laneRelayEventsRoute,
	remoteLaneRaces,
	remoteLaneStats,
	resetLaneRelayReportsForTest,
} from "./lane-relay-events.ts";

const originalToken = process.env.LANE_RELAY_TOKEN;

afterEach(() => {
	if (originalToken === undefined) delete process.env.LANE_RELAY_TOKEN;
	else process.env.LANE_RELAY_TOKEN = originalToken;
	resetLaneRelayReportsForTest();
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
		lastOkAt: 1_000,
		lastSendOkAt: 1_000,
		lastPollOkAt: 1_000,
		applicationRttMs: 15.2,
		applicationSampleAt: 1_000,
		routingEligible: true,
		consecutiveFailures: 0,
		openedAt: 500,
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
		applicationSampleAt: 1_000,
		routingEligible: true,
		send: fixtureScore(),
		poll: fixtureScore(),
	};
}

function reportBody(workerId: string) {
	return {
		workerId,
		ts: Date.now(),
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
