import { describe, expect, test } from "bun:test";
import { decodeCompactMessageResponse } from "./compact.ts";

/** Zigzag + base-128 varint, matching CompactReader's own decode (see compact.ts). */
function encodeZigzagVarint(value: bigint): number[] {
	let n = value >= 0n ? value << 1n : (-value << 1n) - 1n;
	const bytes: number[] = [];
	do {
		let byte = Number(n & 0x7fn);
		n >>= 7n;
		if (n !== 0n) byte |= 0x80;
		bytes.push(byte);
	} while (n !== 0n);
	return bytes;
}

function encodeResponse(sequenceId: number, messageId: bigint, createdTimeMs: bigint): Uint8Array {
	return Uint8Array.from([
		1, // success: true
		...encodeZigzagVarint(BigInt(sequenceId)),
		...encodeZigzagVarint(messageId),
		...encodeZigzagVarint(createdTimeMs),
	]);
}

describe("decodeCompactMessageResponse", () => {
	test("returns createdTime in milliseconds, matching every other createdTime in the codebase", () => {
		// Regression test: this used to divide the wire value (already
		// milliseconds — see the field's own name, createdTimeMs) by 1000
		// before returning it, silently turning this one decode path into
		// seconds while everything else (SquareMessage, inbound-delay.ts's
		// lineCreatedTimeOf) treats createdTime as epoch milliseconds.
		const wireCreatedTimeMs = 1_700_000_000_123n;
		const data = encodeResponse(7, 123456789n, wireCreatedTimeMs);

		const result = decodeCompactMessageResponse(data);

		expect(result.sequenceId).toBe(7);
		expect(result.messageId).toBe(123456789n);
		expect(result.createdTime).toBe(Number(wireCreatedTimeMs));
	});
});
