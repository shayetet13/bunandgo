import { describe, expect, test } from "bun:test";
import { claimResend, clearTrackedReplies, resendText, trackSentReply, uniquifyReply, varyText } from "./reply-defense.ts";

/** The zero-width marks varyText may append, as escapes so they stay legible. */
const INVISIBLE_MARKS = new RegExp("[\\u200B\\u200C\\u2060]", "g");

describe("reply-defense", () => {
	test("claims a resend for a tracked message and consumes the entry", () => {
		const botId = 1;
		trackSentReply(botId, "sq1", "msg1", "hello");

		const claim = claimResend(botId, "sq1", "msg1");
		expect(claim).toEqual({ text: "hello", attempt: 1 });

		// The entry is consumed — a second destroy of the same id (replay)
		// finds nothing left to claim.
		expect(claimResend(botId, "sq1", "msg1")).toBeUndefined();
	});

	test("ignores a destroy for a message we never sent", () => {
		expect(claimResend(1, "sq1", "unknown-message")).toBeUndefined();
	});

	test("stops resending once the budget is spent", () => {
		const botId = 2;
		trackSentReply(botId, "sq1", "m0", "hi", 2); // already at MAX_RESENDS (default 2)
		expect(claimResend(botId, "sq1", "m0")).toBeUndefined();
	});

	test("chains resend attempts across repeated destroys up to the cap", () => {
		const botId = 3;
		trackSentReply(botId, "sq1", "m0", "hi");

		const first = claimResend(botId, "sq1", "m0")!;
		expect(first.attempt).toBe(1);
		trackSentReply(botId, "sq1", "m1", first.text, first.attempt);

		const second = claimResend(botId, "sq1", "m1")!;
		expect(second.attempt).toBe(2);
		trackSentReply(botId, "sq1", "m2", second.text, second.attempt);

		// Budget (default MAX_RESENDS=2) is now spent.
		expect(claimResend(botId, "sq1", "m2")).toBeUndefined();
	});

	test("expires a tracked entry after its TTL", () => {
		const botId = 4;
		const now = 1_000_000;
		trackSentReply(botId, "sq1", "m0", "hi", 0, now);

		expect(claimResend(botId, "sq1", "m0", now + 20_000)).toBeUndefined();
	});

	test("does not mix tracked replies across different bots or chats", () => {
		trackSentReply(5, "sqA", "same-id", "a");
		trackSentReply(6, "sqA", "same-id", "b");
		trackSentReply(5, "sqB", "same-id", "c");

		expect(claimResend(6, "sqA", "same-id")).toEqual({ text: "b", attempt: 1 });
		expect(claimResend(5, "sqB", "same-id")).toEqual({ text: "c", attempt: 1 });
		expect(claimResend(5, "sqA", "same-id")).toEqual({ text: "a", attempt: 1 });
	});

	test("clearTrackedReplies drops only the given bot's entries", () => {
		trackSentReply(7, "sq1", "m0", "hi");
		trackSentReply(8, "sq1", "m0", "hi");

		clearTrackedReplies(7);

		expect(claimResend(7, "sq1", "m0")).toBeUndefined();
		expect(claimResend(8, "sq1", "m0")).toEqual({ text: "hi", attempt: 1 });
	});

	test("varyText keeps the visible text and varies invisibly", () => {
		expect(varyText("hello", 0)).toBe("hello");
		for (let attempt = 1; attempt <= 6; attempt++) {
			const varied = varyText("hello", attempt);
			expect(varied).not.toBe("hello");
			expect(varied.startsWith("hello")).toBe(true);
			// Visible content is untouched — only zero-width marks are added.
			expect(varied.replace(INVISIBLE_MARKS, "")).toBe("hello");
		}
	});

	test("varyText cycles rather than growing without bound", () => {
		// A room that repeats one answer for hours must not accumulate a
		// suffix that eventually dwarfs the message.
		const lengths = Array.from({ length: 40 }, (_, attempt) => varyText("hi", attempt).length);
		expect(Math.max(...lengths)).toBeLessThanOrEqual("hi".length + 2);
	});

	test("consecutive variants of the same reply differ from each other", () => {
		const first = varyText("hi", 1);
		const second = varyText("hi", 2);
		const third = varyText("hi", 3);
		expect(new Set([first, second, third]).size).toBe(3);
	});
});

describe("uniquifyReply", () => {
	test("sends the first occurrence verbatim", () => {
		expect(uniquifyReply(100, "sq1", "ok")).toBe("ok");
	});

	test("varies a repeat of the same text in the same chat", () => {
		const botId = 101;
		const first = uniquifyReply(botId, "sq1", "ok");
		const second = uniquifyReply(botId, "sq1", "ok");
		const third = uniquifyReply(botId, "sq1", "ok");

		expect(first).toBe("ok");
		expect(new Set([first, second, third]).size).toBe(3);
		for (const sent of [second, third]) {
			expect(sent.replace(INVISIBLE_MARKS, "")).toBe("ok");
		}
	});

	test("treats a different reply text as a fresh start", () => {
		const botId = 102;
		uniquifyReply(botId, "sq1", "ok");
		uniquifyReply(botId, "sq1", "ok");

		expect(uniquifyReply(botId, "sq1", "other")).toBe("other");
	});

	test("keeps chats and bots independent", () => {
		uniquifyReply(103, "sq1", "ok");
		expect(uniquifyReply(103, "sq2", "ok")).toBe("ok");
		expect(uniquifyReply(104, "sq1", "ok")).toBe("ok");
	});

	test("starts over once the repeat window has passed", () => {
		const botId = 105;
		const now = 5_000_000;
		uniquifyReply(botId, "sq1", "ok", now);

		expect(uniquifyReply(botId, "sq1", "ok", now + 10 * 60_000)).toBe("ok");
	});

	test("clearTrackedReplies also forgets repeat history", () => {
		const botId = 106;
		uniquifyReply(botId, "sq1", "ok");

		clearTrackedReplies(botId);

		expect(uniquifyReply(botId, "sq1", "ok")).toBe("ok");
	});
});

describe("resendText", () => {
	// The bug this guards: the resend used varyText(text, attempt) while the
	// original used uniquifyReply's own per-chat variant. Two counters over
	// one 8-entry mark table — attempt 1 and variant 1 are the same suffix —
	// so a retry could go out byte-identical to the message a moderator had
	// just deleted, and the rule that matched the original matched it again.

	test("differs from a first, verbatim send of the same text", () => {
		const botId = 200;
		const original = uniquifyReply(botId, "sq1", "ok");

		const retry = resendText(botId, "sq1", "ok");

		expect(original).toBe("ok");
		expect(retry).not.toBe(original);
		expect(retry.replace(INVISIBLE_MARKS, "")).toBe("ok");
	});

	test("differs from the variant the destroyed message actually used", () => {
		const botId = 201;
		uniquifyReply(botId, "sq1", "ok");
		// Variant 1 — the exact case the old attempt-numbered resend collided with.
		const destroyed = uniquifyReply(botId, "sq1", "ok");

		expect(resendText(botId, "sq1", "ok")).not.toBe(destroyed);
	});

	test("keeps differing across the whole resend budget", () => {
		const botId = 202;
		const sent = [uniquifyReply(botId, "sq1", "ok"), resendText(botId, "sq1", "ok"), resendText(botId, "sq1", "ok")];

		expect(new Set(sent).size).toBe(3);
		for (const text of sent) expect(text.replace(INVISIBLE_MARKS, "")).toBe("ok");
	});

	test("never repeats the previous send for any starting variant in the cycle", () => {
		const botId = 203;
		let previous = uniquifyReply(botId, "sq1", "ok");
		// One full cycle of VARIANT_MARKS plus a wrap, to prove the +1 step
		// cannot land back on the bytes it is replacing at any point.
		for (let i = 0; i < 12; i++) {
			const retry = resendText(botId, "sq1", "ok");
			expect(retry).not.toBe(previous);
			previous = retry;
		}
	});
});
