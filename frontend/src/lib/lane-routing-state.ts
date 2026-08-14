import type { LaneRaceLane } from "./types.ts";

export function laneRoutingState(
	lane: Pick<LaneRaceLane, "routingEligible" | "applicationRttMs">,
): "HOT" | "COOL" | "WAIT" {
	if (lane.routingEligible) return "HOT";
	return lane.applicationRttMs !== undefined ? "COOL" : "WAIT";
}
