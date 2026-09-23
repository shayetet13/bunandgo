import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../db/sqlite.ts";
import { createBot, getBot, listBotsForUser, overQuotaBots, isBotOverQuota } from "./bots.ts";
import { createUser, setUserBotQuota, type AuthUser } from "../auth/users.ts";

let nextUsername = 0;

function makeUser(quota: number): AuthUser {
	const user = createUser(`quota-test-${nextUsername++}`, "password-secure-123");
	if (quota !== 1) setUserBotQuota(user.id, quota);
	return { ...user, botQuota: quota };
}

/** Bots land in creation order, so ids ascend with age. */
function makeBots(userId: number, count: number): number[] {
	return Array.from({ length: count }, (_unused, index) => createBot(`bot-${index + 1}`, "DESKTOPWIN", userId).id);
}

describe("bot quota", () => {
	beforeEach(() => {
		db.exec("DELETE FROM bots");
	});

	test("nothing is over quota while the count is within it", () => {
		const user = makeUser(3);
		makeBots(user.id, 3);

		expect(overQuotaBots(user.id, 3)).toHaveLength(0);
	});

	test("keeps the oldest bots and drops the newest", () => {
		// A lapsed subscription should cost the customer the bot they just
		// made, not the one that has been scanned and configured for months.
		const user = makeUser(5);
		const [first, second, third, fourth, fifth] = makeBots(user.id, 5);

		const excess = overQuotaBots(user.id, 2).map((bot) => bot.id);

		expect(excess).toEqual([fifth, fourth, third]);
		expect(excess).not.toContain(first);
		expect(excess).not.toContain(second);
	});

	test("marks the excess bots on the bot object itself", () => {
		const user = makeUser(5);
		const ids = makeBots(user.id, 3);
		setUserBotQuota(user.id, 1);

		expect(getBot(ids[0]!)!.overQuota).toBe(false);
		expect(getBot(ids[1]!)!.overQuota).toBe(true);
		expect(getBot(ids[2]!)!.overQuota).toBe(true);
	});

	test("raising the quota back un-marks them", () => {
		// Stopping is reversible on purpose — paying again must not cost a
		// fresh QR scan.
		const user = makeUser(3);
		const ids = makeBots(user.id, 3);
		setUserBotQuota(user.id, 1);
		expect(isBotOverQuota(ids[2]!)).toBe(true);

		setUserBotQuota(user.id, 3);

		expect(isBotOverQuota(ids[2]!)).toBe(false);
	});

	test("lowering a quota does not delete anything", () => {
		const user = makeUser(4);
		makeBots(user.id, 4);
		setUserBotQuota(user.id, 1);

		expect(listBotsForUser({ ...user, botQuota: 1 })).toHaveLength(4);
	});

	test("an admin is never over quota whatever the column says", () => {
		const admin: AuthUser = { id: 1, username: "admin", role: "admin", active: true, botQuota: 1, exemptIdLock: false };
		const ids = makeBots(admin.id, 3);

		// bootstrapAdmin owns id 1 in the test database.
		for (const id of ids) expect(getBot(id)!.overQuota).toBe(false);
	});

	test("a bot with no owner is never over quota", () => {
		const orphan = createBot("orphan");

		expect(getBot(orphan.id)!.overQuota).toBe(false);
	});

	test("one user's quota does not affect another's bots", () => {
		const poor = makeUser(1);
		const rich = makeUser(5);
		makeBots(poor.id, 3);
		const richIds = makeBots(rich.id, 3);

		for (const id of richIds) expect(getBot(id)!.overQuota).toBe(false);
		expect(overQuotaBots(poor.id, 1)).toHaveLength(2);
	});
});
