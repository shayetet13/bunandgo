import { describe, expect, test } from "bun:test";
import { isRetryableTalkMessageError, retryTalkMessageOperation } from "./talk-message-retry.ts";

describe("Talk message transient recovery", () => {
	test("retries a GOAWAY without losing the in-memory message", async () => {
		let attempts = 0;
		const result = await retryTalkMessageOperation(
			async () => {
				attempts++;
				if (attempts < 3) throw new Error("HTTP 502 upstream: http2: server sent GOAWAY");
				return "decrypted";
			},
			{ delaysMs: [0, 0] },
		);

		expect(result).toBe("decrypted");
		expect(attempts).toBe(3);
	});

	test("retries the truncated/corrupt LEGY response seen beside a GOAWAY", async () => {
		let attempts = 0;
		await retryTalkMessageOperation(
			async () => {
				attempts++;
				if (attempts === 1) {
					throw new RangeError('The value of "offset" is out of range. It must be >= 0 and <= 189. Received 20772');
				}
			},
			{ delaysMs: [0] },
		);
		expect(attempts).toBe(2);
	});

	test("does not retry a permanent message/decryption error", async () => {
		let attempts = 0;
		await expect(
			retryTalkMessageOperation(
				async () => {
					attempts++;
					throw new Error("invalid E2EE key");
				},
				{ delaysMs: [0, 0] },
			),
		).rejects.toThrow("invalid E2EE key");
		expect(attempts).toBe(1);
	});

	test("classifies only known transport-shaped failures", () => {
		expect(isRetryableTalkMessageError(new Error("ECONNRESET"))).toBeTrue();
		expect(isRetryableTalkMessageError(new Error("invalid E2EE key"))).toBeFalse();
	});
});
