import { describe, expect, test } from "bun:test";
import { createBot, updateBotStatus } from "./bots.ts";
import { setChatEnabled } from "./chat-access.ts";
import { createRule } from "./rules.ts";
import { db } from "../db/sqlite.ts";
import { clearPriorityWinsForTests, isPriorityBot, recordPriorityWin, shouldYieldToPriorityBot } from "./priority-answerer.ts";

const insertChatStmt = db.prepare<null, [number, string, string, number]>(
	"INSERT INTO chats (bot_id, mid, surface, joined_at) VALUES (?, ?, ?, ?)",
);
const insertUserStmt = db.prepare<{ id: number }, [string]>(
	"INSERT INTO users (username, password_hash, created_at) VALUES (?, 'x', 0) RETURNING id",
);
const claimBotStmt = db.prepare<null, [number, number]>("UPDATE bots SET owner_user_id = ? WHERE id = ?");

let n = 0;
function owner(): number {
	return insertUserStmt.get(`priority-owner-${n++}`)!.id;
}

// The room-wide query behind shouldYieldToPriorityBot() sees every enabled
// bot in a mid, from any test — so unlike a bot id, mids must be unique per
// test or leftover "big"-named bots from earlier tests pollute the result.
function uniqueMid(): string {
	return `m${String(n++).padStart(32, "0")}`;
}

function joinRoom(botId: number, mid: string, joinedAt: number): void {
	insertChatStmt.run(botId, mid, "square", joinedAt);
	setChatEnabled(botId, mid, true);
}

function addRule(botId: number, matchValue: string): void {
	createRule(botId, {
		surface: "square",
		matchType: "equals",
		matchValue,
		replyText: "reply",
		enabled: true,
		priority: 0,
	});
}

describe("isPriorityBot", () => {
	test("matches configured names regardless of case/spacing", () => {
		const big = createBot("Big");
		const bigsa = createBot("Big Sa");
		const other = createBot("other bot");
		expect(isPriorityBot(big.id)).toBe(true);
		expect(isPriorityBot(bigsa.id)).toBe(true);
		expect(isPriorityBot(other.id)).toBe(false);
	});
});

describe("shouldYieldToPriorityBot", () => {
	test("false when there is no priority bot in the room", () => {
		clearPriorityWinsForTests();
		const room = uniqueMid();
		const ownerId = owner();
		const solo = createBot("solo answerer");
		claimBotStmt.run(ownerId, solo.id);
		joinRoom(solo.id, room, 1);
		addRule(solo.id, "หวย");

		expect(shouldYieldToPriorityBot(solo.id, room, "หวย", "square")).toBe(false);
	});

	test("false when the candidate itself is the priority bot", () => {
		clearPriorityWinsForTests();
		const room = uniqueMid();
		const ownerId = owner();
		const big = createBot("big");
		claimBotStmt.run(ownerId, big.id);
		joinRoom(big.id, room, 1);
		addRule(big.id, "หวย");

		expect(shouldYieldToPriorityBot(big.id, room, "หวย", "square")).toBe(false);
	});

	test("false when the priority bot is offline", () => {
		clearPriorityWinsForTests();
		const room = uniqueMid();
		const ownerId = owner();
		const big = createBot("big");
		const other = createBot("other offline test");
		claimBotStmt.run(ownerId, big.id);
		claimBotStmt.run(ownerId, other.id);
		joinRoom(big.id, room, 1);
		joinRoom(other.id, room, 2);
		addRule(big.id, "หวย");
		addRule(other.id, "หวย");
		// big stays offline

		expect(shouldYieldToPriorityBot(other.id, room, "หวย", "square")).toBe(false);
	});

	test("false when the priority bot's own rules would not match this text", () => {
		clearPriorityWinsForTests();
		const room = uniqueMid();
		const ownerId = owner();
		const big = createBot("bigsa");
		const other = createBot("other no match");
		claimBotStmt.run(ownerId, big.id);
		claimBotStmt.run(ownerId, other.id);
		joinRoom(big.id, room, 1);
		joinRoom(other.id, room, 2);
		updateBotStatus(big.id, "online");
		addRule(big.id, "เช็คโพย"); // different phrase than what other matches
		addRule(other.id, "หวย");

		expect(shouldYieldToPriorityBot(other.id, room, "หวย", "square")).toBe(false);
	});

	test("true when the priority bot is online, has quota, and would also match", () => {
		clearPriorityWinsForTests();
		const room = uniqueMid();
		const ownerId = owner();
		const big = createBot("big");
		const other = createBot("other yields");
		claimBotStmt.run(ownerId, big.id);
		claimBotStmt.run(ownerId, other.id);
		joinRoom(big.id, room, 1);
		joinRoom(other.id, room, 2);
		updateBotStatus(big.id, "online");
		addRule(big.id, "หวย");
		addRule(other.id, "หวย");

		expect(shouldYieldToPriorityBot(other.id, room, "หวย", "square")).toBe(true);
	});

	test("stops yielding once the room's quota (default 2) is spent, for good", () => {
		clearPriorityWinsForTests();
		const room = uniqueMid();
		const ownerId = owner();
		const big = createBot("bigsa");
		const other = createBot("other quota");
		claimBotStmt.run(ownerId, big.id);
		claimBotStmt.run(ownerId, other.id);
		joinRoom(big.id, room, 1);
		joinRoom(other.id, room, 2);
		updateBotStatus(big.id, "online");
		addRule(big.id, "หวย");
		addRule(other.id, "หวย");

		recordPriorityWin(big.id);
		expect(shouldYieldToPriorityBot(other.id, room, "หวย", "square")).toBe(true); // 1 of 2 spent

		recordPriorityWin(big.id);
		expect(shouldYieldToPriorityBot(other.id, room, "หวย", "square")).toBe(false); // quota spent
	});

	test("the quota never comes back — not even a month later", () => {
		clearPriorityWinsForTests();
		const room = uniqueMid();
		const ownerId = owner();
		const big = createBot("big");
		const other = createBot("other no reset");
		claimBotStmt.run(ownerId, big.id);
		claimBotStmt.run(ownerId, other.id);
		joinRoom(big.id, room, 1);
		joinRoom(other.id, room, 2);
		updateBotStatus(big.id, "online");
		addRule(big.id, "หวย");
		addRule(other.id, "หวย");

		recordPriorityWin(big.id);
		recordPriorityWin(big.id);

		const thirtyDaysLater = Date.now() + 30 * 24 * 60 * 60 * 1000;
		expect(shouldYieldToPriorityBot(other.id, room, "หวย", "square", thirtyDaysLater)).toBe(false);
	});

	test("the quota is global, not per room — a win anywhere counts everywhere", () => {
		// A bot can only be an enabled member of one square room at a time
		// (MAX_SQUARE_CHATS_PER_BOT, see chat-access.ts) — that cap belongs to
		// the poller, not to this module, so it is bypassed here with a direct
		// insert to prove the win counter itself is one number per bot, not
		// one per (bot, room).
		clearPriorityWinsForTests();
		const room = uniqueMid();
		const otherRoom = uniqueMid();
		const ownerId = owner();
		const big = createBot("big");
		const other = createBot("other cross room");
		claimBotStmt.run(ownerId, big.id);
		claimBotStmt.run(ownerId, other.id);
		joinRoom(big.id, room, 1);
		joinRoom(other.id, room, 2);
		db.prepare("INSERT INTO chats (bot_id, mid, surface, joined_at, enabled) VALUES (?, ?, 'square', ?, 1)").run(big.id, otherRoom, 1);
		db.prepare("INSERT INTO chats (bot_id, mid, surface, joined_at, enabled) VALUES (?, ?, 'square', ?, 1)").run(other.id, otherRoom, 2);
		updateBotStatus(big.id, "online");
		addRule(big.id, "หวย");
		addRule(other.id, "หวย");

		// One win in `room`, one win in `otherRoom` — quota (2) spent across
		// the two combined, so both rooms should now race fairly.
		recordPriorityWin(big.id);
		recordPriorityWin(big.id);
		expect(shouldYieldToPriorityBot(other.id, room, "หวย", "square")).toBe(false);
		expect(shouldYieldToPriorityBot(other.id, otherRoom, "หวย", "square")).toBe(false);
	});

	test("yields to a priority bot owned by a different user in the same room", () => {
		// The whole point of this module: the priority bot's several accounts
		// sit in one room under different owner_user_id rows (one per staff
		// login), so a candidate must yield to it even without a shared owner
		// — unlike primary-bot.ts's sibling handoff, which is owner-scoped on
		// purpose (different owners must never silence each other there).
		clearPriorityWinsForTests();
		const room = uniqueMid();
		const bigOwner = owner();
		const otherOwner = owner();
		const big = createBot("big");
		const other = createBot("cross-owner other");
		claimBotStmt.run(bigOwner, big.id);
		claimBotStmt.run(otherOwner, other.id);
		joinRoom(big.id, room, 1);
		joinRoom(other.id, room, 2);
		updateBotStatus(big.id, "online");
		addRule(big.id, "หวย");
		addRule(other.id, "หวย");

		expect(bigOwner).not.toBe(otherOwner);
		expect(shouldYieldToPriorityBot(other.id, room, "หวย", "square")).toBe(true);
	});

	test("recordPriorityWin is a no-op for a non-priority bot", () => {
		clearPriorityWinsForTests();
		const room = uniqueMid();
		const ownerId = owner();
		const notBig = createBot("definitely not priority");
		claimBotStmt.run(ownerId, notBig.id);
		joinRoom(notBig.id, room, 1);

		expect(recordPriorityWin(notBig.id)).toBeUndefined();
	});

	test("recordPriorityWin returns the running count so callers can log it", () => {
		clearPriorityWinsForTests();
		const room = uniqueMid();
		const ownerId = owner();
		const big = createBot("big");
		claimBotStmt.run(ownerId, big.id);
		joinRoom(big.id, room, 1);

		expect(recordPriorityWin(big.id)).toBe(1);
		expect(recordPriorityWin(big.id)).toBe(2);
		expect(recordPriorityWin(big.id)).toBe(3);
	});
});
