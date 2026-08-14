import { afterEach, describe, expect, test } from "bun:test";
import type { SquareEvent } from "../linejs-core/types/line_types.ts";
import {
	clearSquareForensics,
	getSquareForensicSnapshot,
	observeSquareForensicEvent,
} from "./square-forensics.ts";

const BOT_ID = 9001;
const CHAT_MID = "m0000000000000000000000000000001";

function messageEvent(id: string, createdTime: number, text: string, from: string): SquareEvent {
	return {
		type: "RECEIVE_MESSAGE",
		payload: {
			receiveMessage: {
				squareChatMid: CHAT_MID,
				squareMessage: {
					message: { id, from, to: CHAT_MID, text, createdTime },
					state: "SENT",
				},
			},
		},
	} as unknown as SquareEvent;
}

afterEach(() => clearSquareForensics(BOT_ID));

describe("passive Square reply forensics", () => {
	test("finds our message without issuing a read-back request", () => {
		observeSquareForensicEvent(BOT_ID, messageEvent("ours", 1_100, "answer", "p-us"), "dedicated-poll", 1_120);
		const snapshot = getSquareForensicSnapshot({
			botId: BOT_ID,
			squareChatMid: CHAT_MID,
			messageId: "ours",
			acceptedLineCreatedTime: 1_100,
			acceptedState: "SENT",
		});
		expect(snapshot.presence).toBe("visible");
		expect(snapshot.observedSource).toBe("dedicated-poll");
		expect(snapshot.timeline[0]?.messageId).toBe("ours");
	});

	test("proves absence only after a newer LINE event has arrived", () => {
		observeSquareForensicEvent(BOT_ID, messageEvent("rival", 1_300, "ครับ", "p-rival"), "dedicated-poll", 1_320);
		const snapshot = getSquareForensicSnapshot({
			botId: BOT_ID,
			squareChatMid: CHAT_MID,
			messageId: "ours",
			acceptedLineCreatedTime: 1_100,
			acceptedState: "SENT",
		});
		expect(snapshot.presence).toBe("missing_after_later_event");
		expect(snapshot.timeline[0]?.text).toBe("ครับ");
	});

	test("records a destroy event for the exact reply id", () => {
		observeSquareForensicEvent(BOT_ID, {
			type: "NOTIFIED_DESTROY_MESSAGE",
			payload: { notifiedDestroyMessage: { squareChatMid: CHAT_MID, messageId: "ours" } },
		} as unknown as SquareEvent, "push", 1_500);
		const snapshot = getSquareForensicSnapshot({
			botId: BOT_ID,
			squareChatMid: CHAT_MID,
			messageId: "ours",
			acceptedLineCreatedTime: 1_100,
		});
		expect(snapshot.presence).toBe("destroyed");
		expect(snapshot.destroyedAt).toBe(1_500);
	});
});
