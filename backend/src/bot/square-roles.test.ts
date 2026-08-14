import { describe, expect, test } from "bun:test";
import type { Client } from "../linejs-core/client/mod.ts";
import { clearSquareRoles, isSquareAdmin, listSquareMembers, resolveSquareMemberRoles } from "./square-roles.ts";

const mid = (prefix: string, tail: string) => prefix + "0".repeat(32 - tail.length) + tail;
const SQUARE_CHAT = mid("m", "aa");
const ADMIN_MID = mid("p", "01");
const CO_ADMIN_MID = mid("p", "02");
const MEMBER_MID = mid("p", "03");

function makeClient(members: Array<{ squareMemberMid: string; displayName: string; role: number }>): Client {
	return {
		base: {
			square: {
				getSquareChatMembers({ continuationToken }: { continuationToken: string }) {
					// Single page — continuationToken empty signals "no more".
					if (continuationToken) return Promise.resolve({ squareChatMembers: [], continuationToken: "" });
					return Promise.resolve({ squareChatMembers: members, continuationToken: "" });
				},
			},
		},
	} as unknown as Client;
}

describe("square member role cache", () => {
	test("caches ADMIN and CO_ADMIN as admin, MEMBER as not", async () => {
		const botId = 9001;
		const client = makeClient([
			{ squareMemberMid: ADMIN_MID, displayName: "Admin", role: 1 },
			{ squareMemberMid: CO_ADMIN_MID, displayName: "Co-admin", role: 2 },
			{ squareMemberMid: MEMBER_MID, displayName: "Member", role: 10 },
		]);

		await resolveSquareMemberRoles(client, botId, [SQUARE_CHAT]);

		expect(isSquareAdmin(botId, SQUARE_CHAT, ADMIN_MID)).toBe(true);
		expect(isSquareAdmin(botId, SQUARE_CHAT, CO_ADMIN_MID)).toBe(true);
		expect(isSquareAdmin(botId, SQUARE_CHAT, MEMBER_MID)).toBe(false);

		clearSquareRoles(botId);
	});

	test("treats an unresolved sender as non-admin (safe default)", () => {
		const botId = 9002;
		expect(isSquareAdmin(botId, SQUARE_CHAT, ADMIN_MID)).toBe(false);
	});

	test("lists resolved members for the dashboard badge", async () => {
		const botId = 9003;
		const client = makeClient([{ squareMemberMid: ADMIN_MID, displayName: "Admin", role: 1 }]);
		await resolveSquareMemberRoles(client, botId, [SQUARE_CHAT]);

		const members = listSquareMembers(botId, SQUARE_CHAT);
		expect(members).toHaveLength(1);
		expect(members[0]).toMatchObject({ mid: ADMIN_MID, displayName: "Admin", role: 1 });

		clearSquareRoles(botId);
	});

	test("clearSquareRoles drops all cached chats for that bot", async () => {
		const botId = 9004;
		const client = makeClient([{ squareMemberMid: ADMIN_MID, displayName: "Admin", role: 1 }]);
		await resolveSquareMemberRoles(client, botId, [SQUARE_CHAT]);
		expect(isSquareAdmin(botId, SQUARE_CHAT, ADMIN_MID)).toBe(true);

		clearSquareRoles(botId);
		expect(isSquareAdmin(botId, SQUARE_CHAT, ADMIN_MID)).toBe(false);
	});

	test("a chat that fails to resolve leaves no cached members (safe default)", async () => {
		const botId = 9005;
		const failingClient = {
			base: { square: { getSquareChatMembers: () => Promise.reject(new Error("network")) } },
		} as unknown as Client;

		await resolveSquareMemberRoles(failingClient, botId, [SQUARE_CHAT]);
		expect(isSquareAdmin(botId, SQUARE_CHAT, ADMIN_MID)).toBe(false);
		expect(listSquareMembers(botId, SQUARE_CHAT)).toEqual([]);
	});
});
