import { describe, expect, test } from "bun:test";
import { laneRoutingState } from "../lib/lane-routing-state.ts";

describe("lane routing state", () => {
	test("shows the currently preferred route as FASTEST", () => {
		expect(laneRoutingState({ routingPreferred: true, applicationRttMs: 31.3 })).toBe("FASTEST");
	});

	test("shows every slower measured route as STANDBY regardless of RTT", () => {
		expect(laneRoutingState({ routingPreferred: false, applicationRttMs: 12 })).toBe("STANDBY");
		expect(laneRoutingState({ routingPreferred: false, applicationRttMs: 82 })).toBe("STANDBY");
	});

	test("shows WAIT before any application measurement exists", () => {
		expect(laneRoutingState({ routingPreferred: false })).toBe("WAIT");
	});
});
