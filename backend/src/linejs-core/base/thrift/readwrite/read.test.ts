import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { bigInt } from "./read.ts";

describe("bigInt (Thrift I64 decode)", () => {
	test("decodes an ordinary positive value as a plain number when it fits safely", () => {
		expect(bigInt(Buffer.from("0000000000000001", "hex"))).toBe(1);
	});

	test("decodes a large positive value beyond Number.MAX_SAFE_INTEGER as a bigint", () => {
		expect(bigInt(Buffer.from("7fffffffffffffff", "hex"))).toBe(9223372036854775807n);
	});

	test("decodes a two's-complement negative wire value correctly instead of as a huge unsigned magnitude", () => {
		// Regression test: the old implementation read the raw bytes as an
		// unsigned magnitude (`BigInt("0x" + hex)` with no sign handling), so
		// the all-ones wire encoding of -1 decoded to 18446744073709551615
		// instead. write.ts's encode side was already fixed for the mirror
		// image of this bug (BigInt.asUintN); this is the missing inverse.
		expect(bigInt(Buffer.from("ffffffffffffffff", "hex"))).toBe(-1);
		expect(bigInt(Buffer.from("fffffffffffffffe", "hex"))).toBe(-2);
	});

	test("decodes a large negative value beyond Number.MIN_SAFE_INTEGER as a bigint", () => {
		expect(bigInt(Buffer.from("8000000000000000", "hex"))).toBe(-9223372036854775808n);
	});
});
