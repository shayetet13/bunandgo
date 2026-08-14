import { describe, expect, test } from "bun:test";
import { measureAnswers, toneForAnswer } from "../lib/live-feed-metrics.ts";
import type { FeedItem } from "../lib/types.ts";

const T = 1_800_000_000_000;

function incoming(id: string, createdTime: number | undefined, room = "roomA", text = "msg"): FeedItem {
	return {
		kind: "in",
		id,
		data: { botId: 1, surface: "square", text, targetMid: room, ts: createdTime ?? T, createdTime },
	};
}

function outgoing(id: string, ts: number, room = "roomA"): FeedItem {
	return {
		kind: "out",
		id,
		data: {
			botId: 1,
			ts,
			surface: "square",
			targetMid: room,
			latencyMs: 20,
			ok: true,
			source: "auto",
			textPreview: "our reply",
		},
	};
}

describe("measureAnswers", () => {
	test("times a reply against the message it answered, on LINE's clock", () => {
		// The rival's reply lands 60ms after the trigger LINE stamped.
		const answers = measureAnswers([incoming("trigger", T), incoming("rival", T + 60)]);

		expect(answers.get("rival")).toBe(60);
	});

	test("gives the first message in a room no number — it answered nothing", () => {
		const answers = measureAnswers([incoming("trigger", T)]);

		expect(answers.has("trigger")).toBe(false);
	});

	test("keeps rooms independent", () => {
		const answers = measureAnswers([
			incoming("a-trigger", T, "roomA"),
			incoming("b-reply", T + 40, "roomB"),
		]);

		// roomB's message is the first in *its* room, so it is nobody's reply
		// even though a message in another room preceded it.
		expect(answers.has("b-reply")).toBe(false);
	});

	test("does not time a message against one too old to be answering it", () => {
		const answers = measureAnswers([incoming("trigger", T), incoming("later", T + 60_000)]);

		expect(answers.has("later")).toBe(false);
	});

	test("our own reply does not become the next trigger", () => {
		// Both bots answer the same trigger; ours landing first must not make
		// the rival look 20ms fast when it actually took 80ms.
		const answers = measureAnswers([
			incoming("trigger", T),
			outgoing("ours", T + 20),
			incoming("rival", T + 80),
		]);

		expect(answers.get("rival")).toBe(80);
	});

	test("skips messages with no LINE stamp rather than inventing a number", () => {
		const answers = measureAnswers([incoming("trigger", T), incoming("unstamped", undefined)]);

		expect(answers.has("unstamped")).toBe(false);
	});

	test("orders by timestamp regardless of the order given", () => {
		const answers = measureAnswers([incoming("rival", T + 60), incoming("trigger", T)]);

		expect(answers.get("rival")).toBe(60);
	});
});

describe("toneForAnswer", () => {
	test("a reply as fast as ours reads as good", () => {
		expect(toneForAnswer(60)).toBe("chip--go");
	});

	test("a visibly slower reply reads as warn, then bad", () => {
		expect(toneForAnswer(300)).toBe("chip--warn");
		expect(toneForAnswer(900)).toBe("chip--bad");
	});
});
