import { describe, expect, test } from "bun:test";
import { TMoreCompactProtocol } from "./tmc.ts";

describe("TMoreCompactProtocol.decodeFieldBitmap", () => {
	test("decodes the set bit positions for an ordinary struct bitmap", () => {
		const proto = new TMoreCompactProtocol();
		expect(proto.decodeFieldBitmap(0b1011)).toEqual([0, 1, 3]);
	});

	test("returns no fields for an empty bitmap", () => {
		const proto = new TMoreCompactProtocol();
		expect(proto.decodeFieldBitmap(0)).toEqual([]);
	});

	test("terminates for a bitmap at and above the 32-bit signed-shift wraparound boundary", () => {
		// Regression test: `1 << 31` wraps negative in JS's 32-bit signed
		// shift, and `1 << 32` wraps back to 1 -- the old implementation's
		// `mask > bitmap` loop condition never became true for any bitmap
		// >= 2^31, hanging forever. This must both terminate and decode
		// correctly, not just avoid throwing.
		const proto = new TMoreCompactProtocol();
		expect(proto.decodeFieldBitmap(2 ** 31)).toEqual([31]);
		expect(proto.decodeFieldBitmap(2 ** 32)).toEqual([32]);
		expect(proto.decodeFieldBitmap(3_000_000_000)).toEqual([9, 10, 11, 12, 14, 20, 22, 23, 25, 28, 29, 31]);
	});

	test("rejects an implausibly large bitmap instead of looping", () => {
		const proto = new TMoreCompactProtocol();
		expect(() => proto.decodeFieldBitmap(2 ** 300)).toThrow("implausible struct field bitmap");
	});
});
