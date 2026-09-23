import { describe, expect, test } from "bun:test";
import { hasWarmHotSendRoute, type WarmResult } from "./warmer.ts";

describe("warmer hot-send readiness", () => {
	test("accepts a healthy legy route when both gf probes time out", () => {
		const results: WarmResult[] = [
			{ host: "go:legy.line-apps.com", tookMs: 30, status: 200 },
			{ host: "go:gf.line.naver.jp", tookMs: 10_000, error: "context deadline exceeded" },
			{ host: "bun:gf.line.naver.jp", tookMs: 10_000, error: "The operation timed out" },
		];

		expect(hasWarmHotSendRoute(results)).toBe(true);
	});

	test("rejects readiness when every legy route failed", () => {
		const results: WarmResult[] = [
			{ host: "go:legy.line-apps.com", tookMs: 10_000, error: "timeout" },
			{ host: "bun:legy.line-apps.com", tookMs: 10_000, error: "timeout" },
			{ host: "bun:gf.line.naver.jp", tookMs: 25, status: 200 },
		];

		expect(hasWarmHotSendRoute(results)).toBe(false);
	});

});
