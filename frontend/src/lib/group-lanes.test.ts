import { describe, expect, test } from "bun:test";
import { groupLanesByWorker, summarizeLaneGroup } from "./group-lanes.ts";
import type { LaneStat } from "./types.ts";

function lane(overrides: Partial<LaneStat>): LaneStat {
	return {
		origin: "https://legy.line-apps.com",
		id: 0,
		workerId: "primary",
		state: "ready",
		inFlight: 0,
		lastOkAt: 0,
		lastSendOkAt: 0,
		lastPollOkAt: 0,
		applicationSampleAt: 0,
		routingPreferred: false,
		consecutiveFailures: 0,
		...overrides,
	};
}

describe("groupLanesByWorker", () => {
	test("merges lanes sharing a worker and origin into one group", () => {
		const groups = groupLanesByWorker([lane({ workerId: "primary", id: 0 }), lane({ workerId: "primary", id: 1 })]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.lanes).toHaveLength(2);
	});

	test("keeps different workers as separate groups", () => {
		const groups = groupLanesByWorker([lane({ workerId: "shard-b" }), lane({ workerId: "primary" })]);
		expect(groups.map((g) => g.workerId)).toEqual(["primary", "shard-b"]);
	});

	test("separates the same worker id across different origins", () => {
		const groups = groupLanesByWorker([
			lane({ workerId: "primary", origin: "https://a.example" }),
			lane({ workerId: "primary", origin: "https://b.example" }),
		]);
		expect(groups).toHaveLength(2);
	});

	test("returns an empty list for no lanes", () => {
		expect(groupLanesByWorker([])).toEqual([]);
	});
});

describe("summarizeLaneGroup", () => {
	test("counts ready lanes and finds the fastest real RTT", () => {
		const summary = summarizeLaneGroup([
			lane({ state: "ready", applicationRttMs: 18.4 }),
			lane({ state: "ready", applicationRttMs: 15.1 }),
			lane({ state: "connecting" }),
		]);
		expect(summary).toEqual({ total: 3, ready: 2, failing: 0, fastestRttMs: 15.1 });
	});

	test("flags dead lanes and lanes with consecutive failures", () => {
		const summary = summarizeLaneGroup([lane({ state: "dead" }), lane({ consecutiveFailures: 2 }), lane({ state: "ready" })]);
		expect(summary.failing).toBe(2);
	});

	test("leaves fastestRttMs undefined when nothing has a real measurement yet", () => {
		expect(summarizeLaneGroup([lane({})]).fastestRttMs).toBeUndefined();
	});
});
