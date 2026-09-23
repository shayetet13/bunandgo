import { describe, expect, test } from "bun:test";
import { createBot, updateBotStatus } from "./bots.ts";
import { setChatEnabled } from "./chat-access.ts";
import { db } from "../db/sqlite.ts";
import { primaryBotIdFor, roomBotsFor, setPrimaryBot } from "./primary-bot.ts";

const insertChatStmt = db.prepare<null, [number, string, string, number]>(
	"INSERT INTO chats (bot_id, mid, surface, joined_at) VALUES (?, ?, ?, ?)",
);
const insertUserStmt = db.prepare<{ id: number }, [string]>(
	"INSERT INTO users (username, password_hash, created_at) VALUES (?, 'x', 0) RETURNING id",
);
const claimBotStmt = db.prepare<null, [number, number]>("UPDATE bots SET owner_user_id = ? WHERE id = ?");

function owner(name: string): number {
	return insertUserStmt.get(name)!.id;
}

function joinRoom(botId: number, mid: string, joinedAt: number, enabled = true): void {
	insertChatStmt.run(botId, mid, "square", joinedAt);
	if (enabled) setChatEnabled(botId, mid, true);
}

const ROOM = "m0000000000000000000000000000000";

describe("primaryBotIdFor", () => {
	test("an unowned bot is always its own sender", () => {
		const bot = createBot("solo unowned");
		joinRoom(bot.id, ROOM, 1);
		expect(primaryBotIdFor(bot.id, ROOM)).toBeUndefined();
	});

	test("an owned bot alone in the room is its own sender", () => {
		const ownerId = owner("solo-owner");
		const bot = createBot("solo owned");
		claimBotStmt.run(ownerId, bot.id);
		joinRoom(bot.id, ROOM, 1);
		expect(primaryBotIdFor(bot.id, ROOM)).toBeUndefined();
	});

	test("defaults to the owner's oldest bot with no explicit primary", () => {
		const ownerId = owner("default-owner");
		const first = createBot("first");
		const second = createBot("second");
		claimBotStmt.run(ownerId, first.id);
		claimBotStmt.run(ownerId, second.id);
		joinRoom(first.id, ROOM, 100);
		joinRoom(second.id, ROOM, 200);

		expect(primaryBotIdFor(first.id, ROOM)).toBeUndefined(); // it IS the default primary
		expect(primaryBotIdFor(second.id, ROOM)).toBe(first.id);
	});

	test("the default follows account age, not this room's join order", () => {
		const ownerId = owner("account-age-owner");
		const first = createBot("account age first");
		const second = createBot("account age second");
		claimBotStmt.run(ownerId, first.id);
		claimBotStmt.run(ownerId, second.id);
		// second joins THIS room before first does, but first is still the
		// owner's older bot account and must stay the default everywhere.
		joinRoom(second.id, ROOM, 100);
		joinRoom(first.id, ROOM, 200);

		expect(primaryBotIdFor(first.id, ROOM)).toBeUndefined(); // it IS the default primary
		expect(primaryBotIdFor(second.id, ROOM)).toBe(first.id);
	});

	test("an explicit primary overrides join order", () => {
		const ownerId = owner("explicit-owner");
		const first = createBot("first x");
		const second = createBot("second x");
		claimBotStmt.run(ownerId, first.id);
		claimBotStmt.run(ownerId, second.id);
		joinRoom(first.id, ROOM, 100);
		joinRoom(second.id, ROOM, 200);

		expect(setPrimaryBot(second.id, ROOM)).toBe(true);
		expect(primaryBotIdFor(first.id, ROOM)).toBe(second.id);
		expect(primaryBotIdFor(second.id, ROOM)).toBeUndefined();
	});

	test("skips an offline default primary in favour of the next-oldest online sibling", () => {
		const ownerId = owner("failover-owner");
		const first = createBot("failover first");
		const second = createBot("failover second");
		const third = createBot("failover third");
		for (const bot of [first, second, third]) db.prepare("UPDATE bots SET owner_user_id = ? WHERE id = ?").run(ownerId, bot.id);
		joinRoom(first.id, ROOM, 100);
		joinRoom(second.id, ROOM, 200);
		joinRoom(third.id, ROOM, 300);
		// first is the default primary (oldest account) but is offline; second
		// is online and next in line; third is also online but should not be
		// preferred over second.
		updateBotStatus(second.id, "online");
		updateBotStatus(third.id, "online");

		expect(primaryBotIdFor(third.id, ROOM)).toBe(second.id);
	});

	test("skips an offline explicit primary in favour of the owner's oldest online sibling", () => {
		const ownerId = owner("failover-explicit-owner");
		const first = createBot("failover explicit first");
		const second = createBot("failover explicit second");
		for (const bot of [first, second]) db.prepare("UPDATE bots SET owner_user_id = ? WHERE id = ?").run(ownerId, bot.id);
		joinRoom(first.id, ROOM, 100);
		joinRoom(second.id, ROOM, 200);
		expect(setPrimaryBot(first.id, ROOM)).toBe(true); // first is explicit primary, but stays offline
		updateBotStatus(second.id, "online");

		expect(primaryBotIdFor(second.id, ROOM)).toBeUndefined(); // second becomes its own sender
	});

	test("falls back to the designated primary when every sibling is offline (unchanged behaviour)", () => {
		const ownerId = owner("all-offline-owner");
		const first = createBot("all offline first");
		const second = createBot("all offline second");
		for (const bot of [first, second]) db.prepare("UPDATE bots SET owner_user_id = ? WHERE id = ?").run(ownerId, bot.id);
		joinRoom(first.id, ROOM, 100);
		joinRoom(second.id, ROOM, 200);

		expect(primaryBotIdFor(second.id, ROOM)).toBe(first.id);
	});

	test("two different owners' bots in the same room never hand off to each other", () => {
		const ownerA = owner("owner-a");
		const ownerB = owner("owner-b");
		const botA = createBot("a");
		const botB = createBot("b");
		claimBotStmt.run(ownerA, botA.id);
		claimBotStmt.run(ownerB, botB.id);
		joinRoom(botA.id, ROOM, 1);
		joinRoom(botB.id, ROOM, 2);

		expect(primaryBotIdFor(botA.id, ROOM)).toBeUndefined();
		expect(primaryBotIdFor(botB.id, ROOM)).toBeUndefined();
	});

	test("a disabled sibling chat is not counted", () => {
		const ownerId = owner("disabled-owner");
		const first = createBot("first d");
		const second = createBot("second d");
		claimBotStmt.run(ownerId, first.id);
		claimBotStmt.run(ownerId, second.id);
		joinRoom(first.id, ROOM, 100, false); // joined but not enabled
		joinRoom(second.id, ROOM, 200);

		expect(primaryBotIdFor(second.id, ROOM)).toBeUndefined();
	});
});

describe("setPrimaryBot", () => {
	test("refuses a bot that is not an enabled member of the room", () => {
		const ownerId = owner("refuse-owner");
		const member = createBot("member");
		const stranger = createBot("stranger");
		claimBotStmt.run(ownerId, member.id);
		claimBotStmt.run(ownerId, stranger.id);
		joinRoom(member.id, ROOM, 1);

		expect(setPrimaryBot(stranger.id, ROOM)).toBe(false);
	});
});

describe("roomBotsFor", () => {
	test("lists siblings oldest bot account first", () => {
		const ownerId = owner("list-owner");
		const first = createBot("list first");
		const second = createBot("list second");
		claimBotStmt.run(ownerId, first.id);
		claimBotStmt.run(ownerId, second.id);
		joinRoom(second.id, ROOM, 200);
		joinRoom(first.id, ROOM, 100);

		const list = roomBotsFor(first.id, ROOM);
		expect(list.map((bot) => bot.botId)).toEqual([first.id, second.id]);
	});
});
