import { describe, expect, test } from "bun:test";
import type { Client, SquareMessage, TalkMessage } from "../linejs-core/client/mod.ts";
import { shouldProcessIncomingMessage } from "./incoming-message-policy.ts";
import { createBot } from "./bots.ts";
import { setChatAdminAllowlist, setChatAdminOnly, setChatEnabled } from "./chat-access.ts";
import { clearSquareRoles, resolveSquareMemberRoles } from "./square-roles.ts";
import { db } from "../db/sqlite.ts";

const insertChatStmt = db.prepare<null, [number, string, string, number]>(
	"INSERT INTO chats (bot_id, mid, surface, joined_at) VALUES (?, ?, ?, ?)",
);

function talkMessage(toType: TalkMessage["to"]["type"], mid = "c0000000000000000000000000000000"): TalkMessage {
	return { to: { type: toType, id: mid } } as unknown as TalkMessage;
}

function squareMessage(mid = "m0000000000000000000000000000000", fromMid = "p0000000000000000000000000000000"): SquareMessage {
	return { to: { id: mid }, from: { id: fromMid } } as unknown as SquareMessage;
}

describe("shouldProcessIncomingMessage", () => {
	test("rejects a one-to-one Talk message even if the chat is enabled", () => {
		const bot = createBot("policy test 1-1");
		insertChatStmt.run(bot.id, "u0000000000000000000000000000000", "talk", Date.now());
		setChatEnabled(bot.id, "u0000000000000000000000000000000", true);

		expect(shouldProcessIncomingMessage(bot.id, "talk", talkMessage("USER", "u0000000000000000000000000000000"))).toBe(false);
		expect(shouldProcessIncomingMessage(bot.id, "talk", talkMessage(0, "u0000000000000000000000000000000"))).toBe(false);
	});

	test("accepts a one-to-one Talk message from a confirmed LINE Official Account once the chat is enabled", () => {
		const bot = createBot("policy test 1-1 OA");
		insertChatStmt.run(bot.id, "u0000000000000000000000000000000", "talk", Date.now());
		setChatEnabled(bot.id, "u0000000000000000000000000000000", true);

		expect(shouldProcessIncomingMessage(bot.id, "talk", talkMessage("USER", "u0000000000000000000000000000000"), true)).toBe(true);
	});

	test("still refuses a one-to-one OA chat that hasn't been enabled", () => {
		const bot = createBot("policy test 1-1 OA disabled");
		insertChatStmt.run(bot.id, "u0000000000000000000000000000000", "talk", Date.now());

		expect(shouldProcessIncomingMessage(bot.id, "talk", talkMessage("USER", "u0000000000000000000000000000000"), true)).toBe(false);
	});

	test("rejects Talk group/room and OpenChat messages when the chat isn't enabled", () => {
		const bot = createBot("policy test disabled");
		insertChatStmt.run(bot.id, "c0000000000000000000000000000000", "talk", Date.now());
		insertChatStmt.run(bot.id, "m0000000000000000000000000000000", "square", Date.now());

		expect(shouldProcessIncomingMessage(bot.id, "talk", talkMessage("GROUP"))).toBe(false);
		expect(shouldProcessIncomingMessage(bot.id, "square", squareMessage())).toBe(false);
	});

	test("accepts Talk group and room messages once the chat is enabled", () => {
		const bot = createBot("policy test group");
		insertChatStmt.run(bot.id, "c0000000000000000000000000000000", "talk", Date.now());
		setChatEnabled(bot.id, "c0000000000000000000000000000000", true);

		expect(shouldProcessIncomingMessage(bot.id, "talk", talkMessage("GROUP"))).toBe(true);
		expect(shouldProcessIncomingMessage(bot.id, "talk", talkMessage("ROOM"))).toBe(true);
		expect(shouldProcessIncomingMessage(bot.id, "talk", talkMessage(2))).toBe(true);
		expect(shouldProcessIncomingMessage(bot.id, "talk", talkMessage(1))).toBe(true);
	});

	test("accepts OpenChat messages once the chat is enabled", () => {
		const bot = createBot("policy test square");
		insertChatStmt.run(bot.id, "m0000000000000000000000000000000", "square", Date.now());
		setChatEnabled(bot.id, "m0000000000000000000000000000000", true);

		expect(shouldProcessIncomingMessage(bot.id, "square", squareMessage())).toBe(true);
	});

	describe("admin-only OpenChat rooms", () => {
		const CHAT_MID = "m1111111111111111111111111111111";
		const ADMIN_MID = "p1111111111111111111111111111111";
		const MEMBER_MID = "p2222222222222222222222222222222";

		function makeClient(): Client {
			return {
				base: {
					square: {
						getSquareChatMembers: () =>
							Promise.resolve({
								squareChatMembers: [{ squareMemberMid: ADMIN_MID, displayName: "Admin", role: 1 }],
								continuationToken: "",
							}),
					},
				},
			} as unknown as Client;
		}

		test("answers a cached ADMIN sender", async () => {
			const bot = createBot("policy test admin-only allow");
			insertChatStmt.run(bot.id, CHAT_MID, "square", Date.now());
			setChatEnabled(bot.id, CHAT_MID, true);
			setChatAdminOnly(bot.id, CHAT_MID, true);
			await resolveSquareMemberRoles(makeClient(), bot.id, [CHAT_MID]);

			expect(shouldProcessIncomingMessage(bot.id, "square", squareMessage(CHAT_MID, ADMIN_MID))).toBe(true);
			clearSquareRoles(bot.id);
		});

		test("stays silent for a non-admin sender", async () => {
			const bot = createBot("policy test admin-only block");
			insertChatStmt.run(bot.id, CHAT_MID, "square", Date.now());
			setChatEnabled(bot.id, CHAT_MID, true);
			setChatAdminOnly(bot.id, CHAT_MID, true);
			await resolveSquareMemberRoles(makeClient(), bot.id, [CHAT_MID]);

			expect(shouldProcessIncomingMessage(bot.id, "square", squareMessage(CHAT_MID, MEMBER_MID))).toBe(false);
			clearSquareRoles(bot.id);
		});

		test("stays silent for a sender whose role hasn't been resolved yet", () => {
			const bot = createBot("policy test admin-only unresolved");
			insertChatStmt.run(bot.id, CHAT_MID, "square", Date.now());
			setChatEnabled(bot.id, CHAT_MID, true);
			setChatAdminOnly(bot.id, CHAT_MID, true);

			expect(shouldProcessIncomingMessage(bot.id, "square", squareMessage(CHAT_MID, ADMIN_MID))).toBe(false);
		});

		test("an empty allowlist still means every admin", async () => {
			// "Not configured" and "configured to nobody" must not look alike —
			// the second would take a working room silent with nothing on the
			// dashboard saying why.
			const bot = createBot("policy test allowlist empty");
			insertChatStmt.run(bot.id, CHAT_MID, "square", Date.now());
			setChatEnabled(bot.id, CHAT_MID, true);
			setChatAdminOnly(bot.id, CHAT_MID, true);
			await resolveSquareMemberRoles(makeClient(), bot.id, [CHAT_MID]);
			setChatAdminAllowlist(bot.id, CHAT_MID, []);

			expect(shouldProcessIncomingMessage(bot.id, "square", squareMessage(CHAT_MID, ADMIN_MID))).toBe(true);
			clearSquareRoles(bot.id);
		});

		test("answers only the chosen admin once an allowlist is set", async () => {
			const bot = createBot("policy test allowlist named");
			insertChatStmt.run(bot.id, CHAT_MID, "square", Date.now());
			setChatEnabled(bot.id, CHAT_MID, true);
			setChatAdminOnly(bot.id, CHAT_MID, true);
			await resolveSquareMemberRoles(makeClient(), bot.id, [CHAT_MID]);
			setChatAdminAllowlist(bot.id, CHAT_MID, ["p9999999999999999999999999999999"]);

			expect(shouldProcessIncomingMessage(bot.id, "square", squareMessage(CHAT_MID, ADMIN_MID))).toBe(false);

			setChatAdminAllowlist(bot.id, CHAT_MID, [ADMIN_MID]);
			expect(shouldProcessIncomingMessage(bot.id, "square", squareMessage(CHAT_MID, ADMIN_MID))).toBe(true);
			clearSquareRoles(bot.id);
		});

		test("an allowlisted member who is not an admin is still refused", async () => {
			// The allowlist narrows the admin check; it never replaces it.
			const bot = createBot("policy test allowlist non-admin");
			insertChatStmt.run(bot.id, CHAT_MID, "square", Date.now());
			setChatEnabled(bot.id, CHAT_MID, true);
			setChatAdminOnly(bot.id, CHAT_MID, true);
			await resolveSquareMemberRoles(makeClient(), bot.id, [CHAT_MID]);
			setChatAdminAllowlist(bot.id, CHAT_MID, [MEMBER_MID]);

			expect(shouldProcessIncomingMessage(bot.id, "square", squareMessage(CHAT_MID, MEMBER_MID))).toBe(false);
			clearSquareRoles(bot.id);
		});

		test("the allowlist is ignored while the room answers everyone", async () => {
			const bot = createBot("policy test allowlist inactive");
			insertChatStmt.run(bot.id, CHAT_MID, "square", Date.now());
			setChatEnabled(bot.id, CHAT_MID, true);
			await resolveSquareMemberRoles(makeClient(), bot.id, [CHAT_MID]);
			setChatAdminAllowlist(bot.id, CHAT_MID, [ADMIN_MID]);

			expect(shouldProcessIncomingMessage(bot.id, "square", squareMessage(CHAT_MID, MEMBER_MID))).toBe(true);
			clearSquareRoles(bot.id);
		});

		test("a talk (classic group) chat ignores admin_only entirely", () => {
			const bot = createBot("policy test admin-only talk");
			insertChatStmt.run(bot.id, "c2222222222222222222222222222222", "talk", Date.now());
			setChatEnabled(bot.id, "c2222222222222222222222222222222", true);
			setChatAdminOnly(bot.id, "c2222222222222222222222222222222", true);

			expect(shouldProcessIncomingMessage(bot.id, "talk", talkMessage("GROUP", "c2222222222222222222222222222222"))).toBe(true);
		});
	});
});
