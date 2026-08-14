import { beforeEach, describe, expect, test } from "bun:test";

// These exercise the limiter's mechanics — the rolling window, and dropping
// rather than queuing — independent of whatever the window is tuned to.
const { tryAcquireSend, clearThrottle } = await import("./rate-limiter.ts");

const BOT = 1;
const OTHER_BOT = 2;

describe("tryAcquireSend", () => {
	beforeEach(() => {
		clearThrottle(BOT);
		clearThrottle(OTHER_BOT);
	});

	test("allows and reserves the first slot immediately", () => {
		expect(tryAcquireSend(BOT, 1_000)).toEqual({
			allowed: true,
			retryAfterMs: 0,
		});
	});

	test("allows back-to-back sends — there is no minimum interval any more", () => {
		// The 3.45-minute cooldown that used to sit here capped a racing bot
		// at one answer per interval. Only the window below limits it now.
		tryAcquireSend(BOT, 1_000);

		expect(tryAcquireSend(BOT, 1_001).allowed).toBe(true);
		expect(tryAcquireSend(BOT, 1_002).allowed).toBe(true);
	});

	test("keeps limiter state isolated per bot", () => {
		tryAcquireSend(BOT, 1_000);

		expect(tryAcquireSend(OTHER_BOT, 1_001).allowed).toBe(true);
	});

	test("drops when the rolling-window quota is full", () => {
		for (let index = 0; index < 20; index++) {
			tryAcquireSend(BOT, 1_000 + index * 1_200);
		}

		expect(tryAcquireSend(BOT, 25_000)).toEqual({
			allowed: false,
			reason: "window",
			retryAfterMs: 36_000,
		});
	});

	test("drops a burst that fills the window in milliseconds", () => {
		// Without the old cooldown this is reachable in one tick, so the
		// window is now the only thing standing between a rival's flood and
		// twenty of our replies.
		for (let index = 0; index < 20; index++) {
			tryAcquireSend(BOT, 1_000 + index);
		}

		expect(tryAcquireSend(BOT, 1_020)).toEqual({
			allowed: false,
			reason: "window",
			retryAfterMs: 59_980,
		});
	});

	test("opens a new slot when the oldest send leaves the window", () => {
		for (let index = 0; index < 20; index++) {
			tryAcquireSend(BOT, 1_000 + index * 1_200);
		}

		expect(tryAcquireSend(BOT, 61_000).allowed).toBe(true);
	});

	test("clearThrottle lets the next message send immediately", () => {
		tryAcquireSend(BOT, 1_000);
		clearThrottle(BOT);

		expect(tryAcquireSend(BOT, 1_001).allowed).toBe(true);
	});
});
