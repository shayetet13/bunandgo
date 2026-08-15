import { describe, expect, test } from "bun:test";
import { reconcileFetchedBots } from "./bot-status-sync.ts";
import type { Bot } from "./types.ts";

function bot(id: number, status: Bot["status"]): Bot {
	return {
		id,
		name: `bot ${id}`,
		slot: id,
		device: "IOSIPAD",
		status,
		ownerUserId: null,
		allowOwnerTesting: false,
		overQuota: false,
		lockedLineMid: null,
		createdAt: 0,
	};
}

describe("reconcileFetchedBots", () => {
	test("keeps a status the socket reported after the fetch was dispatched", () => {
		// The exact shape of the stuck-on-the-QR-screen bug: the fetch was
		// dispatched while the bot was still connecting, the login finished
		// before it answered, and its stale "connecting" must not win.
		const merged = reconcileFetchedBots(
			[bot(1, "online")],
			[bot(1, "connecting")],
			new Map([[1, 1_500]]),
			1_000,
		);
		expect(merged[0]!.status).toBe("online");
	});

	test("takes the fetched status when no event has landed since dispatch", () => {
		const merged = reconcileFetchedBots(
			[bot(1, "connecting")],
			[bot(1, "online")],
			new Map([[1, 500]]),
			1_000,
		);
		expect(merged[0]!.status).toBe("online");
	});

	test("takes the fetched status for a bot the socket never spoke about", () => {
		const merged = reconcileFetchedBots([bot(1, "connecting")], [bot(1, "offline")], new Map(), 1_000);
		expect(merged[0]!.status).toBe("offline");
	});

	test("carries every other field from the fetch, and bots not on screen yet", () => {
		const fetched = { ...bot(1, "connecting"), name: "renamed", allowOwnerTesting: true };
		const merged = reconcileFetchedBots([bot(1, "online")], [fetched, bot(2, "offline")], new Map([[1, 2_000]]), 1_000);
		expect(merged).toEqual([
			{ ...fetched, status: "online" },
			bot(2, "offline"),
		]);
	});
});
