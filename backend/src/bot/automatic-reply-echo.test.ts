import { afterEach, describe, expect, test } from "bun:test";
import { clearAutomaticReplyEchoes, isAutomaticReplyEcho, trackAutomaticReply } from "./automatic-reply-echo.ts";

const BOT = 901;
const SIBLING = 902;
const SCOPE = "user:1";
const OTHER_SCOPE = "user:2";
const TARGET = `c${"a".repeat(32)}`;

afterEach(() => {
	clearAutomaticReplyEchoes(BOT);
	clearAutomaticReplyEchoes(SIBLING);
});

describe("automatic reply echo guard", () => {
	test("recognizes the push echo of a tracked reply", () => {
		trackAutomaticReply(SCOPE, BOT, "talk", TARGET, "ตอบแล้ว", 1_000);

		expect(isAutomaticReplyEcho(SCOPE, "talk", TARGET, "ตอบแล้ว", "msg-1", 1_001)).toBe(true);
	});

	test("keeps recognizing a redelivery by message id", () => {
		trackAutomaticReply(SCOPE, BOT, "square", TARGET, "ตอบแล้ว", 1_000);
		expect(isAutomaticReplyEcho(SCOPE, "square", TARGET, "ตอบแล้ว", "msg-1", 1_001)).toBe(true);

		expect(isAutomaticReplyEcho(SCOPE, "square", TARGET, "ข้อความเปลี่ยน", "msg-1", 1_002)).toBe(true);
	});

	test("does not hide an owner's unrelated message", () => {
		trackAutomaticReply(SCOPE, BOT, "talk", TARGET, "ข้อความตอบ", 1_000);

		expect(isAutomaticReplyEcho(SCOPE, "talk", TARGET, "ข้อความทดสอบ", "msg-2", 1_001)).toBe(false);
	});

	test("can cancel tracking when a send is dropped", () => {
		const cancel = trackAutomaticReply(SCOPE, BOT, "talk", TARGET, "ตอบแล้ว", 1_000);
		cancel();

		expect(isAutomaticReplyEcho(SCOPE, "talk", TARGET, "ตอบแล้ว", "msg-3", 1_001)).toBe(false);
	});

	describe("sibling bots sharing one owner's room (see primary-bot.ts)", () => {
		test("a sibling recognizes another sibling's routed send as its own echo, not a new trigger", () => {
			// BOT is the account that actually sent the reply (e.g. the room's
			// designated primary — see primaryBotIdFor). SIBLING is a different
			// bot of the same owner, also a member of this room, detecting
			// independently over its own connection. Regression test: before
			// this fix, tracking/checking were keyed by raw botId, so SIBLING's
			// own check never matched BOT's tracked entry — a sibling whose
			// rules happened to match the reply text would answer it too,
			// which every *other* sibling (including BOT itself) then also
			// sees as a new trigger, and so on.
			trackAutomaticReply(SCOPE, BOT, "square", TARGET, "รับงานแล้วครับ", 1_000);

			expect(isAutomaticReplyEcho(SCOPE, "square", TARGET, "รับงานแล้วครับ", "msg-4", 1_001)).toBe(true);
		});

		test("does not leak across two different owners' bot groups", () => {
			trackAutomaticReply(SCOPE, BOT, "square", TARGET, "รับงานแล้วครับ", 1_000);

			// A different owner's bots must never treat this as their own echo
			// merely because the reply text happens to coincide.
			expect(isAutomaticReplyEcho(OTHER_SCOPE, "square", TARGET, "รับงานแล้วครับ", "msg-5", 1_001)).toBe(false);
		});

		test("stopping one sibling clears only its own tracked sends, not the whole shared scope", () => {
			trackAutomaticReply(SCOPE, BOT, "square", TARGET, "ก", 1_000);
			trackAutomaticReply(SCOPE, SIBLING, "square", TARGET, "ข", 1_000);

			clearAutomaticReplyEchoes(BOT);

			expect(isAutomaticReplyEcho(SCOPE, "square", TARGET, "ก", "msg-6", 1_001)).toBe(false);
			expect(isAutomaticReplyEcho(SCOPE, "square", TARGET, "ข", "msg-7", 1_001)).toBe(true);
		});
	});
});
