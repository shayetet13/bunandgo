import { describe, expect, test } from "bun:test";
import { laneRoutingState } from "../lib/lane-routing-state.ts";

describe("lane routing state", () => {
	test("shows a currently eligible 16.3ms route as HOT", () => {
		expect(laneRoutingState({ routingEligible: true, applicationRttMs: 16.3 })).toBe("HOT");
	});

	test("shows a measured but excluded 27.2ms route as COOL", () => {
		expect(laneRoutingState({ routingEligible: false, applicationRttMs: 27.2 })).toBe("COOL");
	});

	test("shows WAIT before any application measurement exists", () => {
		expect(laneRoutingState({ routingEligible: false })).toBe("WAIT");
	});
});
