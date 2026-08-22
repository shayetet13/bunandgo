import { describe, expect, test } from "bun:test";
import { laneRaceScore, laneRaceSnapshot, recordLaneRace, scoreLaneSend, shouldScorePollLane } from "./lane-race.ts";

describe("scoreLaneSend", () => {
	test("awards a star to the first measured lane", () => {
		expect(scoreLaneSend(22, undefined)).toBe("star");
	});

	test("allows small network noise around the fastest lane", () => {
		expect(scoreLaneSend(21.5, 20)).toBe("star");
	});

	test("gives a banana when the lane is measurably slower", () => {
		expect(scoreLaneSend(21.6, 20)).toBe("banana");
	});

	test("samples a poll lane at most once per interval", () => {
		const origin = "https://poll-sample.test";
		expect(shouldScorePollLane(origin, 3, 1_000_000)).toBe(true);
		expect(shouldScorePollLane(origin, 3, 1_000_001)).toBe(false);
		expect(shouldScorePollLane(origin, 3, 1_061_000)).toBe(true);
	});

	test("keeps a bounded live score in memory", () => {
		const origin = "https://live-score.test";
		recordLaneRace("send", origin, 7, 20, undefined);
		recordLaneRace("send", origin, 7, 24, 20);

		expect(laneRaceScore(origin, 7, "send")).toMatchObject({
			samples: 2,
			stars: 1,
			bananas: 1,
			bigStars: 0,
			avgRttMs: 22,
			lastResult: "banana",
		});
		expect(laneRaceSnapshot().events).toEqual(expect.arrayContaining([expect.objectContaining({ origin, laneId: 7, role: "send" })]));
	});
});
