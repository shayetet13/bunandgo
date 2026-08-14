import { describe, expect, test } from "bun:test";
import { parseSecondsAndMs, secondsSuffix } from "./seconds-input.ts";

describe("parseSecondsAndMs", () => {
	test("treats an empty field as the top of the chosen minute", () => {
		expect(parseSecondsAndMs("")).toEqual({ seconds: 0, ms: 0 });
		expect(parseSecondsAndMs("   ")).toEqual({ seconds: 0, ms: 0 });
	});

	test("reads a bare number as whole seconds", () => {
		expect(parseSecondsAndMs("5")).toEqual({ seconds: 5, ms: 0 });
		expect(parseSecondsAndMs("05")).toEqual({ seconds: 5, ms: 0 });
		expect(parseSecondsAndMs("59")).toEqual({ seconds: 59, ms: 0 });
	});

	test("reads the fraction as milliseconds the way a decimal second does", () => {
		expect(parseSecondsAndMs("5.2")).toEqual({ seconds: 5, ms: 200 });
		expect(parseSecondsAndMs("5.25")).toEqual({ seconds: 5, ms: 250 });
		expect(parseSecondsAndMs("5.250")).toEqual({ seconds: 5, ms: 250 });
		expect(parseSecondsAndMs("0.007")).toEqual({ seconds: 0, ms: 7 });
		expect(parseSecondsAndMs("59.999")).toEqual({ seconds: 59, ms: 999 });
	});

	test("accepts a comma as the decimal separator", () => {
		expect(parseSecondsAndMs("5,25")).toEqual({ seconds: 5, ms: 250 });
	});

	// Clamping would silently move the post by whole seconds, which is the one
	// thing an exact-time scheduler must never do quietly.
	test("rejects rather than clamps out-of-range seconds", () => {
		expect(parseSecondsAndMs("60")).toBeUndefined();
		expect(parseSecondsAndMs("99")).toBeUndefined();
	});

	test("rejects malformed input", () => {
		expect(parseSecondsAndMs("abc")).toBeUndefined();
		expect(parseSecondsAndMs("-1")).toBeUndefined();
		expect(parseSecondsAndMs("5.1234")).toBeUndefined();
		expect(parseSecondsAndMs("5.")).toBeUndefined();
		expect(parseSecondsAndMs("1:30")).toBeUndefined();
	});
});

describe("secondsSuffix", () => {
	test("pads both halves so the datetime-local parser accepts it", () => {
		expect(secondsSuffix({ seconds: 0, ms: 0 })).toBe(":00.000");
		expect(secondsSuffix({ seconds: 5, ms: 250 })).toBe(":05.250");
		expect(secondsSuffix({ seconds: 59, ms: 999 })).toBe(":59.999");
	});
});
