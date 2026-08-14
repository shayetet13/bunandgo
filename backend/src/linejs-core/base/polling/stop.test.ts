import { describe, expect, test } from "bun:test";
import type { LooseType } from "@evex/loose-types";
import type { BaseClient } from "../core/mod.ts";
import { Polling } from "./mod.ts";

/**
 * Minimal stand-in for the parts of BaseClient the pusher loop touches.
 *
 * `authToken` stays set for the whole test on purpose: it is exactly the
 * condition the old loop waited on, and nothing in production ever clears
 * it, so a loop that only exits on a falsy token never exits at all.
 */
function fakeClient(): { client: BaseClient; counts: { inits: number; closes: number } } {
	const counts = { inits: 0, closes: 0 };
	const conn = {
		close: () => {
			counts.closes++;
			return Promise.resolve();
		},
	};
	const client = {
		authToken: "token-that-is-never-cleared",
		log: () => {},
		push: {
			conns: [] as LooseType[],
			initializeConn: () => {
				counts.inits++;
				client.push.conns[0] = conn;
				return Promise.resolve(conn);
			},
			// Resolves immediately, so an unstopped loop spins as fast as the
			// backoff allows rather than blocking the test.
			InitAndRead: () => Promise.resolve(),
		},
	} as LooseType;
	return { client: client as BaseClient, counts };
}

describe("push pusher loop teardown", () => {
	test("stop() ends the reconnect loop instead of running while a token exists", async () => {
		const { client, counts } = fakeClient();
		const polling = new Polling(client);

		const loop = polling.initLegyPusher();
		// Let the loop get through at least one full connect/read cycle.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(counts.inits).toBeGreaterThan(0);

		polling.stop();
		await loop;

		expect(polling.stopped).toBe(true);
		expect(polling.islisten).toBe(false);

		// The decisive assertion: after stop() resolves, nothing reconnects.
		// This is what stops an abandoned session from re-signing-on to LINE
		// and provoking NOT_AUTHORIZED_DEVICE against the live session.
		const initsAfterStop = counts.inits;
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(counts.inits).toBe(initsAfterStop);
	});

	test("stop() closes the connection the loop was holding", async () => {
		const { client, counts } = fakeClient();
		const polling = new Polling(client);

		const loop = polling.initLegyPusher();
		await new Promise((resolve) => setTimeout(resolve, 50));

		polling.stop();
		await loop;

		expect(counts.closes).toBeGreaterThan(0);
	});

	test("a fresh poller is not born stopped", () => {
		const { client } = fakeClient();
		expect(new Polling(client).stopped).toBe(false);
	});
});
