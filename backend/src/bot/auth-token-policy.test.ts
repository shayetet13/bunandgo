import { describe, expect, test } from "bun:test";
import { shouldDiscardStoredAuthToken } from "./auth-token-policy.ts";

describe("stored LINE auth-token policy", () => {
	test("keeps the token after a transient transport failure", () => {
		expect(shouldDiscardStoredAuthToken(new Error("fetch failed: connection reset"))).toBe(false);
	});

	test("keeps the token while LINE asks for a refresh", () => {
		expect(shouldDiscardStoredAuthToken({ data: { code: "MUST_REFRESH_V3_TOKEN" } })).toBe(false);
	});

	test("discards the token after LINE rejects the device", () => {
		expect(shouldDiscardStoredAuthToken({ data: { e: { code: "NOT_AUTHORIZED_DEVICE" } } })).toBe(true);
	});

	test("recognizes a credential rejection embedded in an error message", () => {
		expect(shouldDiscardStoredAuthToken(new Error("request: AUTHENTICATION_FAILED"))).toBe(true);
	});
});
