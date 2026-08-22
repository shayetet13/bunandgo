import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../db/sqlite.ts";
import type { AuthUser } from "../auth/users.ts";
import { createBot, deleteBot, listBots, reorderBotsForUser, resequenceBotSlots } from "./bots.ts";

function slotsInDisplayOrder(): Array<{ name: string; slot: number }> {
	return listBots().map((bot) => ({ name: bot.name, slot: bot.slot }));
}

const admin: AuthUser = { id: 1, username: "admin", role: "admin", active: true, botQuota: 1, exemptIdLock: false };

describe("bot slot numbering", () => {
	beforeEach(() => {
		db.exec("DELETE FROM bots");
	});

	test("numbers new bots in creation order", () => {
		createBot("first");
		createBot("second");
		createBot("third");

		expect(slotsInDisplayOrder()).toEqual([
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

		expect(slotsInDisplayOrder()).toEqual([
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
		expect(slotsInDisplayOrder()).toEqual([
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

		expect(slotsInDisplayOrder()).toEqual([
			{ name: "first", slot: 1 },
			{ name: "second", slot: 2 },
		]);
	});

	test("repairs duplicate and gapped slots in creation order", () => {
		createBot("first");
		createBot("second");
		createBot("third");
		db.exec("UPDATE bots SET slot = 9 WHERE name = 'second'");
		db.exec("UPDATE bots SET slot = 2 WHERE name = 'third'");

		resequenceBotSlots();

		expect(slotsInDisplayOrder()).toEqual([
			{ name: "first", slot: 1 },
			{ name: "second", slot: 2 },
			{ name: "third", slot: 3 },
		]);
	});

	test("resequencing an already correct table changes nothing", () => {
		createBot("first");
		createBot("second");
		const before = slotsInDisplayOrder();

		resequenceBotSlots();

		expect(slotsInDisplayOrder()).toEqual(before);
	});

	test("persists an admin drag order across startup resequencing", () => {
		const first = createBot("first");
		const second = createBot("second");
		const third = createBot("third");

		reorderBotsForUser(admin, [third.id, first.id, second.id]);
		expect(slotsInDisplayOrder()).toEqual([
			{ name: "third", slot: 3 },
			{ name: "first", slot: 1 },
			{ name: "second", slot: 2 },
		]);

		resequenceBotSlots();
		expect(slotsInDisplayOrder().map((bot) => bot.name)).toEqual(["third", "first", "second"]);
	});

	test("lets a user swap only their own display positions", () => {
		const owner: AuthUser = { id: 71, username: "owner", role: "user", active: true, botQuota: 5, exemptIdLock: false };
		const first = createBot("owner first", "DESKTOPWIN", owner.id);
		const other = createBot("other owner", "DESKTOPWIN", 72);
		const second = createBot("owner second", "DESKTOPWIN", owner.id);

		reorderBotsForUser(owner, [second.id, first.id]);
		expect(slotsInDisplayOrder()).toEqual([
			{ name: "owner second", slot: 3 },
			{ name: "other owner", slot: 2 },
			{ name: "owner first", slot: 1 },
		]);
		expect(() => reorderBotsForUser(owner, [other.id, first.id])).toThrow("inaccessible");
	});
});
