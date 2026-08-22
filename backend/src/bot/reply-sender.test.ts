import { describe, expect, test } from "bun:test";
import type { Client, SquareMessage, TalkMessage } from "../linejs-core/client/mod.ts";
import { sendReply } from "./reply-sender.ts";

// A LINE mid is a one-character type prefix followed by exactly 32 hex
// digits; built here rather than typed out so the length is not a
// transcription error waiting to happen.
const mid = (prefix: string, tail: string) => prefix + "0".repeat(32 - tail.length) + tail;

const GROUP = mid("c", "aa");
const PEER = mid("u", "bb");
const SELF = mid("u", "cc");

interface Recorder {
	compact: { to: string; text: string; e2ee?: boolean; fastAck?: boolean }[];
	replies: string[];
	square: Array<{ squareChatMid: string; text: string; relatedMessageId?: string; fastAck?: boolean }>;
}

function makeClient(rec: Recorder): Client {
	return {
		base: {
			talk: {
				sendCompactMessage(options: { to: string; text: string; e2ee?: boolean; fastAck?: boolean }) {
					rec.compact.push(options);
					return Promise.resolve({});
				},
			},
			square: {
				sendMessage(options: { squareChatMid: string; text: string; relatedMessageId?: string; fastAck?: boolean }) {
					rec.square.push(options);
					return Promise.resolve({});
				},
			},
		},
	} as unknown as Client;
}

function makeTalkMessage(
	rec: Recorder,
	overrides: {
		toType?: string;
		toId?: string;
		fromId?: string;
		isMyMessage?: boolean;
		chunks?: unknown;
	} = {},
): TalkMessage {
	return {
		to: { type: overrides.toType ?? "GROUP", id: overrides.toId ?? GROUP },
		from: { id: overrides.fromId ?? PEER },
		isMyMessage: overrides.isMyMessage ?? false,
		raw: { id: "msg-1", chunks: overrides.chunks },
		reply(text: string) {
			rec.replies.push(text);
			return Promise.resolve();
		},
	} as unknown as TalkMessage;
}

function newRecorder(): Recorder {
	return { compact: [], replies: [], square: [] };
}

describe("sendReply — talk", () => {
	test("uses the compact endpoint for a group", async () => {
		const rec = newRecorder();

		await sendReply(makeClient(rec), "talk", makeTalkMessage(rec), "จองแล้ว");

		expect(rec.compact).toEqual([{ to: GROUP, text: "จองแล้ว", fastAck: true }]);
		expect(rec.replies).toHaveLength(0);
	});

	test("answers a one-to-one chat to the sender, not to ourselves", async () => {
		const rec = newRecorder();
		// In a personal chat `to` is this account, so replying to `to.id`
		// would send the answer back to the bot itself.
		const message = makeTalkMessage(rec, { toType: "USER", toId: SELF, fromId: PEER });

		await sendReply(makeClient(rec), "talk", message, "จองแล้ว");

		expect(rec.compact[0]?.to).toBe(PEER);
	});

	test("keeps the reply encrypted when the incoming message was", async () => {
		const rec = newRecorder();
		const message = makeTalkMessage(rec, { chunks: [new Uint8Array([1])] });

		await sendReply(makeClient(rec), "talk", message, "จองแล้ว");

		expect(rec.compact[0]?.e2ee).toBe(true);
	});

	test("leaves encryption unset for a plain message so LINE can decide", async () => {
		const rec = newRecorder();

		await sendReply(makeClient(rec), "talk", makeTalkMessage(rec), "จองแล้ว");

		expect(rec.compact[0]).not.toHaveProperty("e2ee");
	});

	test("falls back to the thrift path for a mid compact cannot address", async () => {
		const rec = newRecorder();
		// Square-style mids are not user/room/group and would make the
		// compact encoder throw rather than send.
		const message = makeTalkMessage(rec, { toId: mid("m", "dd") });

		await sendReply(makeClient(rec), "talk", message, "จองแล้ว");

		expect(rec.compact).toHaveLength(0);
		expect(rec.replies).toEqual(["จองแล้ว"]);
	});

	test("falls back when the mid is not 32 hex characters", async () => {
		const rec = newRecorder();
		const message = makeTalkMessage(rec, { toId: "cNOTHEX" });

		await sendReply(makeClient(rec), "talk", message, "จองแล้ว");

		expect(rec.compact).toHaveLength(0);
		expect(rec.replies).toEqual(["จองแล้ว"]);
	});
});

describe("sendReply — square", () => {
	test("keeps the full Square result without quoting the original message", async () => {
		const rec = newRecorder();
		const message = {
			raw: { message: { id: "square-msg-1", to: mid("m", "ee") } },
		} as unknown as SquareMessage;

		await sendReply(makeClient(rec), "square", message, "จองแล้ว");

		expect(rec.square).toEqual([
			{
				squareChatMid: mid("m", "ee"),
				text: "จองแล้ว",
				fastAck: false,
			},
		]);
		expect(rec.compact).toHaveLength(0);
	});
});
