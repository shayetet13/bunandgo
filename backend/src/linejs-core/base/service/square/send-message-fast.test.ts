import { describe, expect, test } from "bun:test";
import { LINEStruct, Protocols } from "../../thrift/mod.ts";
import { writeThrift } from "../../thrift/readwrite/write.ts";
import { buildSquareSendMessageArgs } from "./mod.ts";

const CHAT_MID = `m${"a".repeat(32)}`;
type SendOptions = Parameters<typeof buildSquareSendMessageArgs>[1];

function generated(reqSeq: number, options: SendOptions) {
	return LINEStruct.SquareService_sendMessage_args({
		request: {
			reqSeq,
			squareChatMid: CHAT_MID,
			squareMessage: {
				squareMessageRevision: 4,
				message: {
					to: CHAT_MID,
					text: options.text,
					contentType: options.contentType ?? 0,
					contentMetadata: options.contentMetadata ?? {},
					location: options.location,
					...(options.relatedMessageId
						? {
								relatedMessageId: options.relatedMessageId,
								relatedMessageServiceCode: "SQUARE" as const,
								messageRelationType: "REPLY" as const,
							}
						: {}),
				},
			},
		},
	});
}

describe("Square send hot builder", () => {
	const samples: Array<{ reqSeq: number; options: SendOptions }> = [
		{ reqSeq: 7, options: { squareChatMid: CHAT_MID, text: "hello" } },
		{
			reqSeq: 8,
			options: {
				squareChatMid: CHAT_MID,
				text: "reply",
				contentMetadata: { MENTION: "{}" },
				relatedMessageId: "1234567890",
			},
		},
		{
			reqSeq: 9,
			options: {
				squareChatMid: CHAT_MID,
				location: {
					title: "Bangkok",
					latitude: 13.7563,
					longitude: 100.5018,
				} as SendOptions["location"],
			},
		},
	];
	for (const sample of samples) {
		test(`matches generated wire bytes for reqSeq ${sample.reqSeq}`, () => {
			const expected = writeThrift(generated(sample.reqSeq, sample.options), "sendMessage", Protocols[4]);
			const actual = writeThrift(buildSquareSendMessageArgs(sample.reqSeq, sample.options), "sendMessage", Protocols[4]);
			expect(actual).toEqual(expected);
		});
	}
});
