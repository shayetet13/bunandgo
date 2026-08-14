import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../db/sqlite.ts";
import { createBot, deleteBot, listBots, resequenceBotSlots } from "./bots.ts";

function slotsInCreationOrder(): Array<{ name: string; slot: number }> {
	return listBots().map((bot) => ({ name: bot.name, slot: bot.slot }));
}

describe("bot slot numbering", () => {
	beforeEach(() => {
		db.exec("DELETE FROM bots");
	});

	test("numbers new bots in creation order", () => {
		createBot("first");
		createBot("second");
		createBot("third");

		expect(slotsInCreationOrder()).toEqual([
			{ name: "first", slot: 1 },
			{ name: "second", slot: 2 },
			{ name: "third", slot: 3 },
		]);
	});

	/**
	 * The regression this replaces: a freed slot used to be handed to the next
	 * bot created by anyone, so the newest bot could show up as "bot2" while an
	 * older one sat at "bot4". The dashboard labels bots `bot{slot}`, which made
	 * the numbering read as neither creation order nor anything else.
	 */
	test("closes the gap when a bot in the middle is deleted", () => {
		const first = createBot("first");
		const second = createBot("second");
		const third = createBot("third");
		expect([first.slot, second.slot, third.slot]).toEqual([1, 2, 3]);

		deleteBot(second.id);

		expect(slotsInCreationOrder()).toEqual([
			{ name: "first", slot: 1 },
			{ name: "third", slot: 2 },
		]);
	});

	test("gives a bot created after a delete the next number, not the freed one", () => {
		createBot("first");
		const second = createBot("second");
		createBot("third");
		deleteBot(second.id);

		const fourth = createBot("fourth");

		expect(fourth.slot).toBe(3);
		expect(slotsInCreationOrder()).toEqual([
			{ name: "first", slot: 1 },
			{ name: "third", slot: 2 },
			{ name: "fourth", slot: 3 },
		]);
	});

	test("deleting the newest bot leaves the others alone", () => {
		createBot("first");
		createBot("second");
		const third = createBot("third");

		deleteBot(third.id);

		expect(slotsInCreationOrder()).toEqual([
			{ name: "first", slot: 1 },
			{ name: "second", slot: 2 },
		]);
	});

	test("repairs numbering that is already out of order on disk", () => {
		createBot("first");
		createBot("second");
		createBot("third");
		// Reproduces the shape found in production, where a reused slot left
		// the newest bot numbered below an older one.
		db.exec("UPDATE bots SET slot = 9 WHERE name = 'second'");
		db.exec("UPDATE bots SET slot = 2 WHERE name = 'third'");

		resequenceBotSlots();

		expect(slotsInCreationOrder()).toEqual([
			{ name: "first", slot: 1 },
			{ name: "second", slot: 2 },
			{ name: "third", slot: 3 },
		]);
	});

	test("resequencing an already correct table changes nothing", () => {
		createBot("first");
		createBot("second");
		const before = slotsInCreationOrder();

		resequenceBotSlots();

		expect(slotsInCreationOrder()).toEqual(before);
	});
});
