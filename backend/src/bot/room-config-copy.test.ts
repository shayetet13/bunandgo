import { describe, expect, test } from "bun:test";
import { createBot } from "./bots.ts";
import { createRule, listRules } from "./rules.ts";
import { isChatAdminOnly, listChatAdminAllowlist, setChatAdminAllowlist, setChatAdminOnly, setChatEnabled } from "./chat-access.ts";
import { db } from "../db/sqlite.ts";
import { copyRoomConfig, copyRules } from "./room-config-copy.ts";

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

const ROOM = "m0000000000000000000000000000000";

describe("copyRoomConfig", () => {
	test("copies rules and admin-only config to a sibling bot", () => {
		const ownerId = owner("copy-owner");
		const source = createBot("copy source");
		const target = createBot("copy target");
		claimBotStmt.run(ownerId, source.id);
		claimBotStmt.run(ownerId, target.id);

		createRule(source.id, {
			surface: "all",
			matchType: "containsAny",
			matchValue: "จอง",
			replyText: "จองแล้วครับ",
			enabled: true,
			priority: 0,
		});
		insertChatStmt.run(source.id, ROOM, "square", 1);
		setChatAdminOnly(source.id, ROOM, true);

		insertChatStmt.run(target.id, ROOM, "square", 2);
		setChatEnabled(target.id, ROOM, true);

		const result = copyRoomConfig(source.id, target.id, ROOM);
		expect(result).toEqual({ rulesCopied: 1, rulesSkipped: 0, adminOnlyCopied: true });
		expect(listRules(target.id)).toHaveLength(1);
		expect(listRules(target.id)[0]!.matchValue).toBe("จอง");
		expect(isChatAdminOnly(target.id, ROOM)).toBe(true);
	});

	test("running it twice does not duplicate rules", () => {
		const ownerId = owner("copy-owner-twice");
		const source = createBot("copy source 2");
		const target = createBot("copy target 2");
		claimBotStmt.run(ownerId, source.id);
		claimBotStmt.run(ownerId, target.id);
		createRule(source.id, {
			surface: "all",
			matchType: "equals",
			matchValue: "hi",
			replyText: "hello",
			enabled: true,
			priority: 0,
		});
		insertChatStmt.run(target.id, ROOM, "square", 1);
		setChatEnabled(target.id, ROOM, true);

		copyRoomConfig(source.id, target.id, ROOM);
		const second = copyRoomConfig(source.id, target.id, ROOM);

		expect(second).toEqual({ rulesCopied: 0, rulesSkipped: 1, adminOnlyCopied: false });
		expect(listRules(target.id)).toHaveLength(1);
	});

	test("copies the admin allowlist, not just the switch", () => {
		const ownerId = owner("copy-owner-allowlist");
		const source = createBot("allow source");
		const target = createBot("allow target");
		claimBotStmt.run(ownerId, source.id);
		claimBotStmt.run(ownerId, target.id);
		insertChatStmt.run(source.id, ROOM, "square", 1);
		setChatAdminOnly(source.id, ROOM, true);
		setChatAdminAllowlist(source.id, ROOM, ["p1111111111111111111111111111111"]);
		insertChatStmt.run(target.id, ROOM, "square", 2);
		setChatEnabled(target.id, ROOM, true);

		copyRoomConfig(source.id, target.id, ROOM);

		expect(listChatAdminAllowlist(target.id, ROOM)).toEqual(["p1111111111111111111111111111111"]);
	});

	test("refuses bots with different owners", () => {
		const source = createBot("cross source");
		const target = createBot("cross target");
		claimBotStmt.run(owner("cross-a"), source.id);
		claimBotStmt.run(owner("cross-b"), target.id);

		expect(copyRoomConfig(source.id, target.id, ROOM)).toBeUndefined();
	});

	test("refuses when the target has not joined the room yet, but still reports rules copied", () => {
		const ownerId = owner("copy-owner-nojoin");
		const source = createBot("nojoin source");
		const target = createBot("nojoin target");
		claimBotStmt.run(ownerId, source.id);
		claimBotStmt.run(ownerId, target.id);
		insertChatStmt.run(source.id, ROOM, "square", 1);
		setChatAdminOnly(source.id, ROOM, true);
		// target never gets a chats row for ROOM at all.

		const result = copyRoomConfig(source.id, target.id, ROOM);
		expect(result?.adminOnlyCopied).toBe(false);
	});
});

describe("copyRules", () => {
	test("copies rules with no room involved at all", () => {
		const ownerId = owner("rules-only-owner");
		const source = createBot("rules only source");
		const target = createBot("rules only target");
		claimBotStmt.run(ownerId, source.id);
		claimBotStmt.run(ownerId, target.id);
		createRule(source.id, {
			surface: "all",
			matchType: "equals",
			matchValue: "สวัสดี",
			replyText: "หวัดดีครับ",
			enabled: true,
			priority: 0,
		});

		expect(copyRules(source.id, target.id)).toEqual({ rulesCopied: 1, rulesSkipped: 0 });
		expect(listRules(target.id)).toHaveLength(1);
	});

	test("refuses bots with different owners", () => {
		const source = createBot("rules cross source");
		const target = createBot("rules cross target");
		claimBotStmt.run(owner("rules-cross-a"), source.id);
		claimBotStmt.run(owner("rules-cross-b"), target.id);

		expect(copyRules(source.id, target.id)).toBeUndefined();
	});
});
