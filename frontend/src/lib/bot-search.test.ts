import { describe, expect, test } from "bun:test";
import type { Bot } from "./types.ts";
import { botMatchesSearch } from "./bot-search.ts";

const bot: Bot = {
	id: 117,
	slot: 4,
	name: "ชื่อที่ลงทะเบียน",
	device: "DESKTOPWIN",
	status: "online",
	ownerUserId: 9,
	allowOwnerTesting: false,
	overQuota: false,
	lockedLineMid: "u0123456789abcdef",
	lockedLineDisplayName: "ชื่อบัญชี LINE จริง",
	createdAt: 1,
};

describe("bot search", () => {
	test("finds registration name, durable id, display slot, LINE mid, and LINE display name", () => {
		for (const query of ["ลงทะเบียน", "117", "#117", "id 117", "bot4", "u012345", "line จริง"]) {
			expect(botMatchesSearch(bot, query)).toBe(true);
		}
	});

	test("is Unicode/case insensitive and rejects unrelated text", () => {
		expect(botMatchesSearch(bot, "LINE")).toBe(true);
		expect(botMatchesSearch(bot, "ไม่ใช่บอทนี้")).toBe(false);
	});
});
