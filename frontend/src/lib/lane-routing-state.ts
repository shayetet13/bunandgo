import type { LaneRaceLane } from "./types.ts";

export function laneRoutingState(lane: Pick<LaneRaceLane, "routingPreferred" | "applicationRttMs">): "FASTEST" | "STANDBY" | "WAIT" {
	if (lane.routingPreferred) return "FASTEST";
	return lane.applicationRttMs !== undefined ? "STANDBY" : "WAIT";
}
