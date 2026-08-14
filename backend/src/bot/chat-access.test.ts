import { describe, expect, test } from "bun:test";
import { createBot } from "./bots.ts";
import { db } from "../db/sqlite.ts";
import { MAX_SQUARE_CHATS_PER_BOT, setChatEnabled } from "./chat-access.ts";
import { FAST_SQUARE_POLL_MAX_ROOMS } from "./fast-square-poller.ts";

const insertChatStmt = db.prepare<null, [number, string, string, number]>(
	"INSERT INTO chats (bot_id, mid, surface, joined_at) VALUES (?, ?, ?, ?)",
);

function squareMid(n: number): string {
	return `m${n.toString().padStart(32, "0")}`;
}

describe("setChatEnabled — square room cap", () => {
	test("never exceeds the fast-poll budget — a bot can never have a candidate room selectFastPollRooms has to reject", () => {
		// If this ever fails, someone changed one constant without the other:
		// a room cap looser than the poll budget brings back the exact bug
		// this coupling exists to prevent — a quiet room losing the ranking
		// to a busier one and never getting a poller. See chat-access.ts.
		expect(MAX_SQUARE_CHATS_PER_BOT).toBe(FAST_SQUARE_POLL_MAX_ROOMS);
	});

	test("enables up to the cap with no resistance", () => {
		const bot = createBot("cap test ok");
		for (let i = 0; i < MAX_SQUARE_CHATS_PER_BOT; i++) insertChatStmt.run(bot.id, squareMid(i), "square", Date.now());

		for (let i = 0; i < MAX_SQUARE_CHATS_PER_BOT; i++) {
			expect(setChatEnabled(bot.id, squareMid(i), true)).toBe("ok");
		}
	});

	test("refuses the room past the cap", () => {
		const bot = createBot("cap test refuse");
		for (let i = 0; i <= MAX_SQUARE_CHATS_PER_BOT; i++) insertChatStmt.run(bot.id, squareMid(i), "square", Date.now());
		for (let i = 0; i < MAX_SQUARE_CHATS_PER_BOT; i++) setChatEnabled(bot.id, squareMid(i), true);

		expect(setChatEnabled(bot.id, squareMid(MAX_SQUARE_CHATS_PER_BOT), true)).toBe("room_limit");
	});

	test("disabling one first frees a slot for another", () => {
		const bot = createBot("cap test swap");
		for (let i = 0; i <= MAX_SQUARE_CHATS_PER_BOT; i++) insertChatStmt.run(bot.id, squareMid(i), "square", Date.now());
		for (let i = 0; i < MAX_SQUARE_CHATS_PER_BOT; i++) setChatEnabled(bot.id, squareMid(i), true);

		setChatEnabled(bot.id, squareMid(0), false);
		expect(setChatEnabled(bot.id, squareMid(MAX_SQUARE_CHATS_PER_BOT), true)).toBe("ok");
	});

	test("re-enabling an already-enabled room is a no-op against the cap", () => {
		const bot = createBot("cap test idempotent");
		for (let i = 0; i < MAX_SQUARE_CHATS_PER_BOT; i++) insertChatStmt.run(bot.id, squareMid(i), "square", Date.now());
		for (let i = 0; i < MAX_SQUARE_CHATS_PER_BOT; i++) setChatEnabled(bot.id, squareMid(i), true);

		expect(setChatEnabled(bot.id, squareMid(0), true)).toBe("ok");
	});

	test("Talk chats are exempt from the square cap", () => {
		const bot = createBot("cap test talk exempt");
		for (let i = 0; i < MAX_SQUARE_CHATS_PER_BOT; i++) insertChatStmt.run(bot.id, squareMid(i), "square", Date.now());
		for (let i = 0; i < MAX_SQUARE_CHATS_PER_BOT; i++) setChatEnabled(bot.id, squareMid(i), true);
		insertChatStmt.run(bot.id, "c1111111111111111111111111111111", "talk", Date.now());

		expect(setChatEnabled(bot.id, "c1111111111111111111111111111111", true)).toBe("ok");
	});

	test("unknown chat is reported distinctly from the cap", () => {
		const bot = createBot("cap test unknown");
		expect(setChatEnabled(bot.id, squareMid(0), true)).toBe("not_found");
	});
});
