import { describe, expect, test } from "bun:test";
import type { Client } from "../linejs-core/client/mod.ts";
import {
	clearOfficialAccountCache,
	fetchOfficialAccountFriends,
	isKnownOfficialAccount,
	resolveOfficialAccountStatus,
} from "./oa-contacts.ts";

const mid = (prefix: string, tail: string) => prefix + "0".repeat(32 - tail.length) + tail;
const OA_MID = mid("u", "aa");
const HUMAN_MID = mid("u", "bb");

function makeClient(botType: unknown): Client {
	return {
		base: {
			buddy: {
				getBuddyDetail: () => Promise.resolve({ botType }),
			},
		},
	} as unknown as Client;
}

describe("official-account contact cache", () => {
	test("caches an OFFICIAL botType as an OA", async () => {
		const botId = 9101;
		await resolveOfficialAccountStatus(makeClient("OFFICIAL"), botId, OA_MID);
		expect(isKnownOfficialAccount(botId, OA_MID)).toBe(true);
		clearOfficialAccountCache(botId);
	});

	test("also accepts the legacy LINE_AT / LINE_AT_0 botType values", async () => {
		const botId = 9102;
		await resolveOfficialAccountStatus(makeClient("LINE_AT_0"), botId, OA_MID);
		expect(isKnownOfficialAccount(botId, OA_MID)).toBe(true);
		clearOfficialAccountCache(botId);

		const botId2 = 9103;
		await resolveOfficialAccountStatus(makeClient("LINE_AT"), botId2, OA_MID);
		expect(isKnownOfficialAccount(botId2, OA_MID)).toBe(true);
		clearOfficialAccountCache(botId2);
	});

	test("caches a RESERVED/regular contact as not an OA", async () => {
		const botId = 9104;
		await resolveOfficialAccountStatus(makeClient("RESERVED"), botId, HUMAN_MID);
		expect(isKnownOfficialAccount(botId, HUMAN_MID)).toBe(false);
		clearOfficialAccountCache(botId);
	});

	test("an unresolved mid reads as undefined, not false — the reply gate must not confuse the two", () => {
		const botId = 9105;
		expect(isKnownOfficialAccount(botId, OA_MID)).toBeUndefined();
	});

	test("a failed lookup leaves the mid uncached so the next message retries", async () => {
		const botId = 9106;
		const failingClient = {
			base: { buddy: { getBuddyDetail: () => Promise.reject(new Error("network")) } },
		} as unknown as Client;

		await resolveOfficialAccountStatus(failingClient, botId, OA_MID);
		expect(isKnownOfficialAccount(botId, OA_MID)).toBeUndefined();
	});

	test("clearOfficialAccountCache drops all cached mids for that bot", async () => {
		const botId = 9107;
		await resolveOfficialAccountStatus(makeClient("OFFICIAL"), botId, OA_MID);
		expect(isKnownOfficialAccount(botId, OA_MID)).toBe(true);

		clearOfficialAccountCache(botId);
		expect(isKnownOfficialAccount(botId, OA_MID)).toBeUndefined();
	});

	test("concurrent lookups for the same mid only call getBuddyDetail once", async () => {
		const botId = 9108;
		let calls = 0;
		const client = {
			base: {
				buddy: {
					getBuddyDetail: async () => {
						calls++;
						await new Promise((resolve) => setTimeout(resolve, 5));
						return { botType: "OFFICIAL" };
					},
				},
			},
		} as unknown as Client;

		await Promise.all([
			resolveOfficialAccountStatus(client, botId, OA_MID),
			resolveOfficialAccountStatus(client, botId, OA_MID),
			resolveOfficialAccountStatus(client, botId, OA_MID),
		]);

		expect(calls).toBe(1);
		expect(isKnownOfficialAccount(botId, OA_MID)).toBe(true);
		clearOfficialAccountCache(botId);
	});
});

function makeFriendsClient(rawUsers: Array<{ mid: string; userType: unknown; profileName?: string }>): Client {
	return {
		fetchUsers: () =>
			Promise.resolve(
				rawUsers.map((u) => ({
					mid: u.mid,
					raw: { targetUserMid: u.mid, userType: u.userType, targetProfileDetail: { profileName: u.profileName } },
				})),
			),
	} as unknown as Client;
}

describe("fetchOfficialAccountFriends", () => {
	test("finds OA friends by the string userType and skips regular users", async () => {
		const botId = 9201;
		const client = makeFriendsClient([
			{ mid: mid("u", "01"), userType: "USER", profileName: "Somchai" },
			{ mid: mid("u", "02"), userType: "BOT", profileName: "ร้านค้า OA" },
		]);

		const found = await fetchOfficialAccountFriends(client, botId);

		expect(found).toEqual([{ mid: mid("u", "02"), displayName: "ร้านค้า OA" }]);
		expect(isKnownOfficialAccount(botId, mid("u", "02"))).toBe(true);
		expect(isKnownOfficialAccount(botId, mid("u", "01"))).toBeUndefined();
		clearOfficialAccountCache(botId);
	});

	test("also accepts the numeric (2) and bigint (2n) userType shapes a thrift decoder can produce", async () => {
		const botIdNumeric = 9202;
		const numericClient = makeFriendsClient([{ mid: mid("u", "03"), userType: 2 }]);
		expect((await fetchOfficialAccountFriends(numericClient, botIdNumeric)).map((f) => f.mid)).toEqual([mid("u", "03")]);
		clearOfficialAccountCache(botIdNumeric);

		const botIdBigint = 9203;
		const bigintClient = makeFriendsClient([{ mid: mid("u", "04"), userType: 2n }]);
		expect((await fetchOfficialAccountFriends(bigintClient, botIdBigint)).map((f) => f.mid)).toEqual([mid("u", "04")]);
		clearOfficialAccountCache(botIdBigint);
	});

	test("falls back to the mid as displayName when no profile name is present", async () => {
		const botId = 9204;
		const client = makeFriendsClient([{ mid: mid("u", "05"), userType: "BOT", profileName: "" }]);

		const found = await fetchOfficialAccountFriends(client, botId);

		expect(found).toEqual([{ mid: mid("u", "05"), displayName: mid("u", "05") }]);
		clearOfficialAccountCache(botId);
	});

	test("an empty friend list finds nothing and does not throw", async () => {
		const botId = 9205;
		expect(await fetchOfficialAccountFriends(makeFriendsClient([]), botId)).toEqual([]);
	});
});
