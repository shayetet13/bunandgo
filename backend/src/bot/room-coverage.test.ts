import { describe, expect, test } from "bun:test";
import { createBot } from "./bots.ts";
import { setChatEnabled } from "./chat-access.ts";
import { db } from "../db/sqlite.ts";
import { roomCoverageReport } from "./room-coverage.ts";

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

describe("roomCoverageReport", () => {
	test("groups a user's bots by room, counting only enabled square chats", () => {
		const ownerId = owner("coverage-owner");
		const a = createBot("cov a");
		const b = createBot("cov b");
		claimBotStmt.run(ownerId, a.id);
		claimBotStmt.run(ownerId, b.id);

		insertChatStmt.run(a.id, "m1111111111111111111111111111111", "square", 1);
		setChatEnabled(a.id, "m1111111111111111111111111111111", true);
		insertChatStmt.run(b.id, "m1111111111111111111111111111111", "square", 2);
		setChatEnabled(b.id, "m1111111111111111111111111111111", true);
		// A disabled second room must not appear at all.
		insertChatStmt.run(a.id, "m2222222222222222222222222222222", "square", 3);
		// A talk chat must never be counted as room coverage.
		insertChatStmt.run(a.id, "c3333333333333333333333333333333", "talk", 4);
		setChatEnabled(a.id, "c3333333333333333333333333333333", true);

		const report = roomCoverageReport();
		const entry = report.find((u) => u.userId === ownerId);
		expect(entry).toBeDefined();
		expect(entry!.rooms).toHaveLength(1);
		expect(entry!.rooms[0]!.mid).toBe("m1111111111111111111111111111111");
		expect(entry!.rooms[0]!.botCount).toBe(2);
		expect(entry!.rooms[0]!.bots.map((bot) => bot.botId).sort()).toEqual([a.id, b.id].sort());
	});

	test("an unowned bot never appears in the report", () => {
		const bot = createBot("cov unowned");
		insertChatStmt.run(bot.id, "m4444444444444444444444444444444", "square", 1);
		setChatEnabled(bot.id, "m4444444444444444444444444444444", true);

		const report = roomCoverageReport();
		for (const user of report) {
			for (const room of user.rooms) {
				expect(room.bots.some((b) => b.botId === bot.id)).toBe(false);
			}
		}
	});
});
