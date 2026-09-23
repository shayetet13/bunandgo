import { describe, expect, test } from "bun:test";
import { parseLimit } from "./limit.ts";

describe("parseLimit", () => {
	test("uses the fallback for missing and invalid values", () => {
		expect(parseLimit(undefined, 100, 1000)).toBe(100);
		expect(parseLimit("invalid", 100, 1000)).toBe(100);
	});

	test("clamps values to a safe positive range", () => {
		expect(parseLimit("-5", 100, 1000)).toBe(1);
		expect(parseLimit("0", 100, 1000)).toBe(1);
		expect(parseLimit("42.9", 100, 1000)).toBe(42);
		expect(parseLimit("9999", 100, 1000)).toBe(1000);
	});
});
