import { describe, expect, test } from "bun:test";
import type { Bot } from "./types.ts";
import { applyVisibleBotOrder, moveBotCard } from "./bot-order.ts";

function bot(id: number, ownerUserId: number, slot = id): Bot {
	return {
		id,
		slot,
		name: `bot-${id}`,
		device: "DESKTOPWIN",
		status: "offline",
		ownerUserId,
		allowOwnerTesting: false,
		overQuota: false,
		lockedLineMid: null,
		lockedLineDisplayName: null,
		createdAt: id,
	};
}

describe("bot card ordering", () => {
	test("reorders sibling cards without changing owner", () => {
		const result = moveBotCard([bot(1, 10), bot(2, 10), bot(3, 20)], 2, 1);
		expect(result.map((item) => item.id)).toEqual([2, 1, 3]);
		expect(result.map((item) => item.ownerUserId)).toEqual([10, 10, 20]);
	});

	test("moves the complete owner group when a card crosses owner boundaries", () => {
		const result = moveBotCard([bot(1, 10), bot(2, 10), bot(3, 20), bot(4, 30)], 1, 4);
		expect(result.map((item) => item.id)).toEqual([3, 4, 1, 2]);
	});

	test("optimistically reorders cards without changing their stable slots", () => {
		const result = applyVisibleBotOrder([bot(1, 10, 2), bot(2, 10, 5)], [2, 1]);
		expect(result.map((item) => [item.id, item.slot])).toEqual([
			[2, 5],
			[1, 2],
		]);
	});
});
