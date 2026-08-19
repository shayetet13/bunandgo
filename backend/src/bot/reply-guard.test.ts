import { beforeEach, describe, expect, test } from "bun:test";
import { claimIncomingMessage, claimJobAnswer, claimReply, claimRoomAnswer, clearBotClaims } from "./reply-guard.ts";

const BOT = 1;
const OTHER_BOT = 2;
const CHAT = "c0000000000000000000000000000001";
const OTHER_CHAT = "c0000000000000000000000000000002";
const RULE = 10;
const OTHER_RULE = 11;
const SQUARE = "square";
const TALK = "talk";

describe("claimReply", () => {
	beforeEach(() => {
		clearBotClaims(BOT);
		clearBotClaims(OTHER_BOT);
	});

	test("answers a message the first time it is seen", () => {
		expect(claimReply(BOT, CHAT, RULE, "msg-1")).toBe(true);
	});

	test("refuses the same message delivered twice", () => {
		claimReply(BOT, CHAT, RULE, "msg-1");

		expect(claimReply(BOT, CHAT, RULE, "msg-1")).toBe(false);
	});

	test("refuses every redelivery, not just the second", () => {
		claimReply(BOT, CHAT, RULE, "msg-1");

		const retries = [
			claimReply(BOT, CHAT, RULE, "msg-1"),
			claimReply(BOT, CHAT, RULE, "msg-1"),
			claimReply(BOT, CHAT, RULE, "msg-1"),
		];

		expect(retries).toEqual([false, false, false]);
	});

	test("answers the same keyword again when it arrives as a new message", () => {
		claimReply(BOT, CHAT, RULE, "msg-1");

		expect(claimReply(BOT, CHAT, RULE, "msg-2")).toBe(true);
	});

	test("does not let one chat suppress another", () => {
		claimReply(BOT, CHAT, RULE, "msg-1");

		expect(claimReply(BOT, OTHER_CHAT, RULE, "msg-1")).toBe(true);
	});

	test("does not let one rule suppress another", () => {
		claimReply(BOT, CHAT, RULE, "msg-1");

		expect(claimReply(BOT, CHAT, OTHER_RULE, "msg-1")).toBe(true);
	});

	test("does not let one bot suppress another", () => {
		claimReply(BOT, CHAT, RULE, "msg-1");

		expect(claimReply(OTHER_BOT, CHAT, RULE, "msg-1")).toBe(true);
	});

	test("refuses a redelivery that arrives after a different message", () => {
		claimReply(BOT, CHAT, RULE, "msg-1");
		claimReply(BOT, CHAT, RULE, "msg-2");

		expect(claimReply(BOT, CHAT, RULE, "msg-1")).toBe(false);
	});

	test("keeps chat and rule fields from bleeding into each other", () => {
		// Guards against a key built by plain concatenation, where
		// chat "a" + rule 1 and chat "a1" + rule "" would collide.
		claimReply(BOT, "a", 1, "msg-1");

		expect(claimReply(BOT, "a 1", 0, "msg-1")).toBe(true);
	});
});

describe("claimIncomingMessage", () => {
	beforeEach(() => {
		clearBotClaims(BOT);
		clearBotClaims(OTHER_BOT);
	});

	test("accepts a message the first time it is seen", () => {
		expect(claimIncomingMessage(BOT, SQUARE, "msg-1")).toBe(true);
	});

	test("refuses the same message id delivered again — the push/fast-poll race", () => {
		// This is the exact shape of the 2026-08-09 bug: the ordinary push
		// connection and the fast Square poller both observed one real
		// message and each called into the handler with the same id.
		expect(claimIncomingMessage(BOT, SQUARE, "msg-1")).toBe(true);
		expect(claimIncomingMessage(BOT, SQUARE, "msg-1")).toBe(false);
	});

	test("refuses every redelivery, not just the second — a three-way race stays answered once", () => {
		claimIncomingMessage(BOT, SQUARE, "msg-1");

		const retries = [
			claimIncomingMessage(BOT, SQUARE, "msg-1"),
			claimIncomingMessage(BOT, SQUARE, "msg-1"),
		];

		expect(retries).toEqual([false, false]);
	});

	test("does not let one surface suppress another", () => {
		claimIncomingMessage(BOT, SQUARE, "msg-1");

		expect(claimIncomingMessage(BOT, TALK, "msg-1")).toBe(true);
	});

	test("does not let one bot suppress another", () => {
		claimIncomingMessage(BOT, SQUARE, "msg-1");

		expect(claimIncomingMessage(OTHER_BOT, SQUARE, "msg-1")).toBe(true);
	});

	test("a new message id from the same room is its own claim", () => {
		claimIncomingMessage(BOT, SQUARE, "msg-1");

		expect(claimIncomingMessage(BOT, SQUARE, "msg-2")).toBe(true);
	});
});

describe("claimRoomAnswer", () => {
	const OWNER = "user:7";
	const OTHER_OWNER = "user:8";

	beforeEach(() => {
		clearBotClaims(BOT);
		clearBotClaims(OTHER_BOT);
	});

	test("the first of an owner's bots to arrive answers", () => {
		expect(claimRoomAnswer(OWNER, BOT, CHAT, "msg-1")).toBe(true);
	});

	test("silences the owner's other bots on the same message", () => {
		claimRoomAnswer(OWNER, BOT, CHAT, "msg-1");

		expect(claimRoomAnswer(OWNER, OTHER_BOT, CHAT, "msg-1")).toBe(false);
	});

	test("does not silence a different owner's bot racing in the same room", () => {
		// Two customers' fleets in one OpenChat are competitors, not a team.
		claimRoomAnswer(OWNER, BOT, CHAT, "msg-1");

		expect(claimRoomAnswer(OTHER_OWNER, OTHER_BOT, CHAT, "msg-1")).toBe(true);
	});

	test("keeps each message independent", () => {
		claimRoomAnswer(OWNER, BOT, CHAT, "msg-1");

		expect(claimRoomAnswer(OWNER, OTHER_BOT, CHAT, "msg-2")).toBe(true);
	});

	test("keeps each room independent", () => {
		claimRoomAnswer(OWNER, BOT, CHAT, "msg-1");

		expect(claimRoomAnswer(OWNER, OTHER_BOT, OTHER_CHAT, "msg-1")).toBe(true);
	});

	test("releases the room when the bot that claimed it stops", () => {
		// Otherwise a bot that answered and then died holds its siblings
		// silent for the rest of the TTL.
		claimRoomAnswer(OWNER, BOT, CHAT, "msg-1");

		clearBotClaims(BOT);

		expect(claimRoomAnswer(OWNER, OTHER_BOT, CHAT, "msg-1")).toBe(true);
	});

	test("re-answers once the claim has expired", () => {
		claimRoomAnswer(OWNER, BOT, CHAT, "msg-1", 0);

		expect(claimRoomAnswer(OWNER, OTHER_BOT, CHAT, "msg-1", 10 * 60_000 + 1)).toBe(true);
	});
});

describe("claimJobAnswer", () => {
	beforeEach(() => {
		clearBotClaims(BOT);
		clearBotClaims(OTHER_BOT);
	});

	test("answers the first message in a room", () => {
		expect(claimJobAnswer(BOT, CHAT)).toBe(true);
	});

	test("refuses a second message about the same job soon after", () => {
		claimJobAnswer(BOT, CHAT, 0);

		expect(claimJobAnswer(BOT, CHAT, 5_000)).toBe(false);
	});

	test("answers again once the job's cooldown has passed", () => {
		claimJobAnswer(BOT, CHAT, 0);

		expect(claimJobAnswer(BOT, CHAT, 15_000 + 1)).toBe(true);
	});

	test("a fresh answer restarts the cooldown", () => {
		claimJobAnswer(BOT, CHAT, 0);
		claimJobAnswer(BOT, CHAT, 15_000 + 1); // new job, also claims

		expect(claimJobAnswer(BOT, CHAT, 15_000 + 5_000)).toBe(false); // too soon after the second answer
	});

	test("does not let one room suppress another", () => {
		claimJobAnswer(BOT, CHAT, 0);

		expect(claimJobAnswer(BOT, OTHER_CHAT, 0)).toBe(true);
	});

	test("does not let one bot suppress another in the same room", () => {
		claimJobAnswer(BOT, CHAT, 0);

		expect(claimJobAnswer(OTHER_BOT, CHAT, 0)).toBe(true);
	});

	test("a stopped bot's cooldown does not outlive it", () => {
		claimJobAnswer(BOT, CHAT, 0);

		clearBotClaims(BOT);

		expect(claimJobAnswer(BOT, CHAT, 1)).toBe(true);
	});
});

describe("clearBotClaims", () => {
	beforeEach(() => {
		clearBotClaims(BOT);
		clearBotClaims(OTHER_BOT);
	});

	test("lets a restarted bot answer a message it already answered", () => {
		claimReply(BOT, CHAT, RULE, "msg-1");

		clearBotClaims(BOT);

		expect(claimReply(BOT, CHAT, RULE, "msg-1")).toBe(true);
	});

	test("leaves other bots' claims intact", () => {
		claimReply(BOT, CHAT, RULE, "msg-1");
		claimReply(OTHER_BOT, CHAT, RULE, "msg-1");

		clearBotClaims(BOT);

		expect(claimReply(OTHER_BOT, CHAT, RULE, "msg-1")).toBe(false);
	});

	test("clears every chat the bot was in", () => {
		claimReply(BOT, CHAT, RULE, "msg-1");
		claimReply(BOT, OTHER_CHAT, RULE, "msg-1");

		clearBotClaims(BOT);

		expect(claimReply(BOT, CHAT, RULE, "msg-1")).toBe(true);
		expect(claimReply(BOT, OTHER_CHAT, RULE, "msg-1")).toBe(true);
	});

	test("does not clear a bot whose id shares a prefix", () => {
		// Bot 1 and bot 12 share the "1" prefix; clearing one must not
		// touch the other.
		claimReply(1, CHAT, RULE, "msg-1");
		claimReply(12, CHAT, RULE, "msg-1");

		clearBotClaims(1);

		expect(claimReply(12, CHAT, RULE, "msg-1")).toBe(false);
		clearBotClaims(12);
	});

	test("also forgets that bot's incoming-message claims, not just its reply claims", () => {
		claimIncomingMessage(BOT, SQUARE, "msg-1");

		clearBotClaims(BOT);

		expect(claimIncomingMessage(BOT, SQUARE, "msg-1")).toBe(true);
	});

	test("leaves another bot's incoming-message claims intact", () => {
		claimIncomingMessage(BOT, SQUARE, "msg-1");
		claimIncomingMessage(OTHER_BOT, SQUARE, "msg-1");

		clearBotClaims(BOT);

		expect(claimIncomingMessage(OTHER_BOT, SQUARE, "msg-1")).toBe(false);
	});

	test("also forgets that bot's job cooldown, not just its reply claims", () => {
		claimJobAnswer(BOT, CHAT);

		clearBotClaims(BOT);

		expect(claimJobAnswer(BOT, CHAT)).toBe(true);
	});

	test("leaves another bot's job cooldown intact", () => {
		claimJobAnswer(BOT, CHAT);
		claimJobAnswer(OTHER_BOT, CHAT);

		clearBotClaims(BOT);

		expect(claimJobAnswer(OTHER_BOT, CHAT)).toBe(false);
	});
});
