import type { LaneRaceLane } from "./types.ts";

export function laneRoutingState(
	lane: Pick<LaneRaceLane, "routingEligible" | "applicationRttMs">,
): "HOT" | "WARM" | "COOL" | "WAIT" {
	if (lane.routingEligible) return "HOT";
	if (lane.applicationRttMs !== undefined && lane.applicationRttMs < 23) return "WARM";
	return lane.applicationRttMs !== undefined ? "COOL" : "WAIT";
}
