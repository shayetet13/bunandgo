import { afterEach, describe, expect, test } from "bun:test";
import { clearAutomaticReplyEchoes, isAutomaticReplyEcho, trackAutomaticReply } from "./automatic-reply-echo.ts";

const BOT = 901;
const TARGET = `c${"a".repeat(32)}`;

afterEach(() => clearAutomaticReplyEchoes(BOT));

describe("automatic reply echo guard", () => {
	test("recognizes the push echo of a tracked reply", () => {
		trackAutomaticReply(BOT, "talk", TARGET, "ตอบแล้ว", 1_000);

		expect(isAutomaticReplyEcho(BOT, "talk", TARGET, "ตอบแล้ว", "msg-1", 1_001)).toBe(true);
	});

	test("keeps recognizing a redelivery by message id", () => {
		trackAutomaticReply(BOT, "square", TARGET, "ตอบแล้ว", 1_000);
		expect(isAutomaticReplyEcho(BOT, "square", TARGET, "ตอบแล้ว", "msg-1", 1_001)).toBe(true);

		expect(isAutomaticReplyEcho(BOT, "square", TARGET, "ข้อความเปลี่ยน", "msg-1", 1_002)).toBe(true);
	});

	test("does not hide an owner's unrelated message", () => {
		trackAutomaticReply(BOT, "talk", TARGET, "ข้อความตอบ", 1_000);

		expect(isAutomaticReplyEcho(BOT, "talk", TARGET, "ข้อความทดสอบ", "msg-2", 1_001)).toBe(false);
	});

	test("can cancel tracking when a send is dropped", () => {
		const cancel = trackAutomaticReply(BOT, "talk", TARGET, "ตอบแล้ว", 1_000);
		cancel();

		expect(isAutomaticReplyEcho(BOT, "talk", TARGET, "ตอบแล้ว", "msg-3", 1_001)).toBe(false);
	});
});
