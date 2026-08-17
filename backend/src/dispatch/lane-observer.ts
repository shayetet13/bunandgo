export type ObservedLaneRole = "send" | "poll";

export interface ObservedLaneRace {
	role: ObservedLaneRole;
	origin: string;
	laneId: number;
	rttMs: number;
	benchmarkMs?: number;
}

type LaneRaceObserver = (sample: ObservedLaneRace) => void;

let observer: LaneRaceObserver | undefined;

/** Keeps the transport reusable by a stateless Lane Node with no SQLite. */
export function registerLaneRaceObserver(next: LaneRaceObserver): void {
	observer = next;
}

export function observeLaneRace(sample: ObservedLaneRace): void {
	observer?.(sample);
}
