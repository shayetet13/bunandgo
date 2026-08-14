import { describe, expect, test } from "bun:test";
import { Protocols, Thrift } from "../linejs-core/base/thrift/mod.ts";
import { PREWARM_SQUARE_ACK, PREWARM_TALK_ACK } from "./prewarm-ack.ts";

/**
 * The prewarm ACKs stand in for a real LINE response while the send path is
 * being compiled against RAM. Whatever they contain has to survive the same
 * readers a genuine response meets, because the caller decides how to parse
 * long after the transport has handed the bytes back.
 */
describe("prewarm Square ACK", () => {
	const thrift = new Thrift();

	test("passes the fast-ACK validator", () => {
		expect(thrift.isSuccessfulResponse(PREWARM_SQUARE_ACK, Protocols[4])).toBe(true);
	});

	/**
	 * The regression: a truncated ACK still satisfied `isSuccessfulResponse`,
	 * so it looked correct anywhere `fastAck` was set. Every other `/SQ1`
	 * caller — `fetchSquareChatEvents` on the poller, and any `sendMessage`
	 * without `fastAck` — asks for a full parse instead, and threw
	 * `InputBufferUnderrunError` on the missing trailing stop bytes. That
	 * throw propagated out of the login flow and left the bot offline.
	 */
	test("is a complete Thrift message a full parse can read", () => {
		expect(() => thrift.readThrift(PREWARM_SQUARE_ACK, Protocols[4])).not.toThrow();
	});

	test("reads back as a success envelope, not an exception", () => {
		const parsed = thrift.readThrift(PREWARM_SQUARE_ACK, Protocols[4]);
		expect(parsed.data[1]).toBeUndefined();
	});
});

describe("prewarm Talk ACK", () => {
	// Compact Talk replies are length-prefixed single bytes, not Thrift, and
	// are read by `#requestCompactMessage`'s `parsedBody[0] === 1` check.
	test("is the single success byte the compact reader expects", () => {
		expect([...PREWARM_TALK_ACK]).toEqual([1]);
	});
});
