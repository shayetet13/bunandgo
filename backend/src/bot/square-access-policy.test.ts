import { describe, expect, test } from "bun:test";
import { isSquareAccessDenied } from "./square-access-policy.ts";

describe("Square access policy", () => {
	test("recognizes LINE's explicit room permission denial", () => {
		expect(isSquareAccessDenied(new Error("AUTHENTICATION_FAILURE: You don't have permission to access this section."))).toBe(true);
	});

	test("recognizes a structured rejection without treating transient failures as fatal", () => {
		expect(isSquareAccessDenied({ errorCode: "AUTHENTICATION_FAILURE" })).toBe(true);
		expect(isSquareAccessDenied(new Error("fetch failed: connection reset"))).toBe(false);
	});
});
