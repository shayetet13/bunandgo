import { describe, expect, test } from "bun:test";
import { attachRawDispatchBody, readResponseBytes } from "./raw-response.ts";

describe("raw dispatch response body", () => {
	test("reuses the relay-owned byte view", async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const response = attachRawDispatchBody(new Response(bytes), bytes);
		expect(await readResponseBytes(response)).toBe(bytes);
	});

	test("falls back for a normal fetch response", async () => {
		const response = new Response(new Uint8Array([4, 5]));
		expect(await readResponseBytes(response)).toEqual(new Uint8Array([4, 5]));
	});
});
