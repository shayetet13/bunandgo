import { describe, expect, test } from "bun:test";
import type { Client } from "../linejs-core/client/mod.ts";
import {
	clearOfficialAccountCache,
	fetchOfficialAccountFriends,
	isOfficialAccountContact,
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
	test("recognises OA contact signals returned by talk.getContact", () => {
		expect(isOfficialAccountContact({ capableBuddy: true, type: "USER" })).toBe(true);
		expect(isOfficialAccountContact({ capableBuddy: false, type: "PROMOTION_BOT" })).toBe(true);
		expect(isOfficialAccountContact({ capableBuddy: false, type: "USER" })).toBe(false);
	});

	test("uses getContact capableBuddy before the legacy buddy lookup", async () => {
		const botId = 9100;
		let buddyCalls = 0;
		const client = {
			base: {
				talk: { getContact: () => Promise.resolve({ capableBuddy: true, type: "USER" }) },
				buddy: {
					getBuddyDetail: () => {
						buddyCalls++;
						return Promise.reject(new Error("not a buddy mid"));
					},
				},
			},
		} as unknown as Client;

		await resolveOfficialAccountStatus(client, botId, OA_MID);
		expect(isKnownOfficialAccount(botId, OA_MID)).toBe(true);
		expect(buddyCalls).toBe(0);
		clearOfficialAccountCache(botId);
	});

	test("still checks BuddyDetail when Contact says capableBuddy=false", async () => {
		const botId = 9109;
		const client = {
			base: {
				talk: { getContact: () => Promise.resolve({ capableBuddy: false, type: "USER" }) },
				buddy: { getBuddyDetail: () => Promise.resolve({ botType: "OFFICIAL" }) },
			},
		} as unknown as Client;

		await resolveOfficialAccountStatus(client, botId, OA_MID);
		expect(isKnownOfficialAccount(botId, OA_MID)).toBe(true);
		clearOfficialAccountCache(botId);
	});

	test("keeps a regular 1:1 contact when BuddyDetail also cannot identify an OA", async () => {
		const botId = 9110;
		const client = {
			base: {
				talk: { getContact: () => Promise.resolve({ capableBuddy: false, type: "USER" }) },
				buddy: { getBuddyDetail: () => Promise.reject(new Error("not a buddy mid")) },
			},
		} as unknown as Client;

		await resolveOfficialAccountStatus(client, botId, HUMAN_MID);
		expect(isKnownOfficialAccount(botId, HUMAN_MID)).toBe(false);
		clearOfficialAccountCache(botId);
	});

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

function makeFriendsClient(
	rawUsers: Array<{ mid: string; profileName?: string }>,
	botTypeByMid: Record<string, unknown | undefined>,
): Client {
	return {
		fetchUsers: () => Promise.resolve(rawUsers.map((u) => ({ mid: u.mid, raw: { targetProfileDetail: { profileName: u.profileName } } }))),
		base: {
			buddy: {
				getBuddyDetail: ({ buddyMid }: { buddyMid: string }) => {
					const botType = botTypeByMid[buddyMid];
					if (botType === undefined) return Promise.reject(new Error("not a buddy"));
					return Promise.resolve({ botType });
				},
			},
		},
	} as unknown as Client;
}

describe("fetchOfficialAccountFriends", () => {
	test("classifies each friend via getBuddyDetail's botType, skipping plain users", async () => {
		const botId = 9201;
		const client = makeFriendsClient(
			[
				{ mid: mid("u", "01"), profileName: "Somchai" },
				{ mid: mid("u", "02"), profileName: "ร้านค้า OA" },
			],
			{ [mid("u", "01")]: "RESERVED", [mid("u", "02")]: "OFFICIAL" },
		);

		const found = await fetchOfficialAccountFriends(client, botId);

		expect(found).toEqual([{ mid: mid("u", "02"), displayName: "ร้านค้า OA" }]);
		expect(isKnownOfficialAccount(botId, mid("u", "02"))).toBe(true);
		expect(isKnownOfficialAccount(botId, mid("u", "01"))).toBeUndefined();
		clearOfficialAccountCache(botId);
	});

	test("a friend that isn't a buddy at all (getBuddyDetail rejects) is treated as not an OA, not an error", async () => {
		const botId = 9202;
		const client = makeFriendsClient([{ mid: mid("u", "03"), profileName: "Somchai" }], {});

		const found = await fetchOfficialAccountFriends(client, botId);

		expect(found).toEqual([]);
		expect(isKnownOfficialAccount(botId, mid("u", "03"))).toBeUndefined();
	});

	test("falls back to the mid as displayName when no profile name is present", async () => {
		const botId = 9204;
		const client = makeFriendsClient([{ mid: mid("u", "05"), profileName: "" }], { [mid("u", "05")]: "OFFICIAL" });

		const found = await fetchOfficialAccountFriends(client, botId);

		expect(found).toEqual([{ mid: mid("u", "05"), displayName: mid("u", "05") }]);
		clearOfficialAccountCache(botId);
	});

	test("an empty friend list finds nothing and does not throw", async () => {
		const botId = 9205;
		expect(await fetchOfficialAccountFriends(makeFriendsClient([], {}), botId)).toEqual([]);
	});

	test("classifies many friends with bounded concurrency, not one request at a time or all at once", async () => {
		const botId = 9206;
		const friends = Array.from({ length: 25 }, (_, i) => ({ mid: mid("u", String(i).padStart(2, "0")), profileName: `Friend ${i}` }));
		let inFlight = 0;
		let maxInFlight = 0;
		const client = {
			fetchUsers: () => Promise.resolve(friends.map((u) => ({ mid: u.mid, raw: { targetProfileDetail: { profileName: u.profileName } } }))),
			base: {
				buddy: {
					getBuddyDetail: async ({ buddyMid }: { buddyMid: string }) => {
						inFlight++;
						maxInFlight = Math.max(maxInFlight, inFlight);
						await new Promise((resolve) => setTimeout(resolve, 1));
						inFlight--;
						return { botType: buddyMid === friends[0]!.mid ? "OFFICIAL" : "RESERVED" };
					},
				},
			},
		} as unknown as Client;

		const found = await fetchOfficialAccountFriends(client, botId);

		expect(found.map((f) => f.mid)).toEqual([friends[0]!.mid]);
		expect(maxInFlight).toBeGreaterThan(1);
		expect(maxInFlight).toBeLessThanOrEqual(8);
		clearOfficialAccountCache(botId);
	});
});
