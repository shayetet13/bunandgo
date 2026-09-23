import { describe, expect, test } from "bun:test";
import { squareSelfMidKey } from "./square-self-mid-key.ts";

describe("squareSelfMidKey", () => {
	test("two different bots joined to the same OpenChat never collide", () => {
		// This is the exact cross-tenant scenario the bug produced: bot 1 and
		// bot 2 are both members of square chat `m...aaa`. Before this key
		// included botId, whichever bot resolved its self-mid first would
		// silently become "the" cached self-mid for every other bot in that
		// chat too.
		const chatMid = `m${"a".repeat(32)}`;
		expect(squareSelfMidKey(1, chatMid)).not.toBe(squareSelfMidKey(2, chatMid));
	});

	test("different chats for the same bot never collide", () => {
		expect(squareSelfMidKey(1, `m${"a".repeat(32)}`)).not.toBe(squareSelfMidKey(1, `m${"b".repeat(32)}`));
	});

	test("no numeric botId prefix can be mistaken for a different, longer botId", () => {
		// If keys were naively concatenated without a separator, bot 1's key
		// for chat "10:..." could collide with bot 10's key for a chat mid
		// that happens to start with "0:...". Real square chat mids always
		// start with the literal "m", never a digit, so this can't happen —
		// asserted here as the property that makes it safe.
		const chatMid = `m${"0".repeat(32)}`;
		expect(squareSelfMidKey(1, chatMid).startsWith(squareSelfMidKey(10, chatMid))).toBe(false);
		expect(squareSelfMidKey(10, chatMid).startsWith(squareSelfMidKey(1, chatMid))).toBe(false);
	});

	test("is stable for the same inputs, so repeated lookups hit the same entry", () => {
		expect(squareSelfMidKey(42, "mchat")).toBe(squareSelfMidKey(42, "mchat"));
	});
});
