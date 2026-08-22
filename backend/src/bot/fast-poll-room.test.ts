import { describe, expect, test } from "bun:test";
import { selectFastPollRooms } from "./fast-poll-room.ts";

const room = (mid: string, recentMessages: number) => ({ mid, recentMessages });

/** The single-room budget, which is still the default everywhere. */
function pick(candidates: ReadonlyArray<{ mid: string; recentMessages: number }>, current: string | undefined): string | undefined {
	return selectFastPollRooms(candidates, current === undefined ? [] : [current], 1)[0];
}

describe("selectFastPollRooms — one room per bot", () => {
	test("returns nothing when the bot has no room it may reply in", () => {
		expect(pick([], undefined)).toBeUndefined();
		expect(pick([], "a")).toBeUndefined();
	});

	test("picks the only candidate", () => {
		expect(pick([room("a", 0)], undefined)).toBe("a");
	});

	test("picks the busiest room when nothing is running yet", () => {
		expect(pick([room("a", 1), room("b", 9), room("c", 4)], undefined)).toBe("b");
	});

	test("falls back to the caller's order when every room is silent", () => {
		expect(pick([room("a", 0), room("b", 0)], undefined)).toBe("a");
	});

	test("keeps a room that is still seeing traffic even when another is busier", () => {
		// Switching costs a re-prime drain, so a live room is not abandoned
		// for a busier one — only for having gone quiet.
		expect(pick([room("a", 1), room("b", 50)], "a")).toBe("a");
	});

	test("moves to the busiest room once the current one goes quiet", () => {
		expect(pick([room("a", 0), room("b", 3), room("c", 7)], "a")).toBe("c");
	});

	test("stays put when every room is quiet, including the current one", () => {
		expect(pick([room("a", 0), room("b", 0)], "b")).toBe("b");
	});

	test("leaves a room that is no longer enabled", () => {
		expect(pick([room("a", 0), room("b", 2)], "gone")).toBe("b");
	});

	test("a whole fleet independently converges on the one busiest room", () => {
		// No sibling avoidance: primary-bot.ts routes the reply through one
		// designated answerer regardless of who detected it, so every bot
		// landing on the room that matters is pure upside now.
		const rooms = [room("a", 100), room("b", 4), room("c", 1)];
		for (let count = 0; count < 3; count++) {
			expect(pick(rooms, undefined)).toBe("a");
		}
	});

	test("is stable across repeated calls with unchanged input", () => {
		const candidates = [room("a", 0), room("b", 0), room("c", 0)];
		let chosen = pick(candidates, undefined);
		for (let i = 0; i < 5; i++) chosen = pick(candidates, chosen);
		expect(chosen).toBe("a");
	});
});

describe("selectFastPollRooms — a raised budget", () => {
	test("one bot covers several rooms, busiest first", () => {
		// The point of the budget: four rooms need one account allowed four
		// rooms, not four accounts.
		expect(selectFastPollRooms([room("a", 1), room("b", 9), room("c", 4)], [], 3)).toEqual(["b", "c", "a"]);
	});

	test("never returns more rooms than the budget", () => {
		expect(selectFastPollRooms([room("a", 1), room("b", 9), room("c", 4)], [], 2)).toEqual(["b", "c"]);
	});

	test("never returns more rooms than the bot actually has", () => {
		expect(selectFastPollRooms([room("a", 1)], [], 5)).toEqual(["a"]);
	});

	test("a budget of zero polls nothing", () => {
		expect(selectFastPollRooms([room("a", 5)], [], 0)).toEqual([]);
	});

	test("keeps every live room it already holds", () => {
		const rooms = [room("a", 2), room("b", 3), room("c", 99)];
		expect(selectFastPollRooms(rooms, ["a", "b"], 2).sort()).toEqual(["a", "b"]);
	});

	test("replaces only the room that went quiet", () => {
		const rooms = [room("a", 4), room("b", 0), room("c", 7)];
		const chosen = selectFastPollRooms(rooms, ["a", "b"], 2);
		expect(chosen).toContain("a");
		expect(chosen).toContain("c");
		expect(chosen).not.toContain("b");
	});

	test("drops down cleanly when the budget is lowered", () => {
		const rooms = [room("a", 3), room("b", 4), room("c", 5)];
		expect(selectFastPollRooms(rooms, ["a", "b", "c"], 1)).toHaveLength(1);
	});

	test("is stable across repeated calls with unchanged input", () => {
		const rooms = [room("a", 5), room("b", 4), room("c", 3)];
		let chosen = selectFastPollRooms(rooms, [], 2);
		for (let i = 0; i < 5; i++) chosen = selectFastPollRooms(rooms, chosen, 2);
		expect(chosen.sort()).toEqual(["a", "b"]);
	});
});
