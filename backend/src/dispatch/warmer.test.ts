import { afterEach, describe, expect, test } from "bun:test";
import { hasWarmHotSendRoute, warmOnce, type WarmResult } from "./warmer.ts";

const savedRelayEnv = new Map<string, string | undefined>();
const relayEnvKeys = ["LINE_RELAY_MODE", "LINE_RELAY_URL", "LINE_RELAY_TOKEN"] as const;

afterEach(() => {
	for (const key of relayEnvKeys) {
		const value = savedRelayEnv.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	savedRelayEnv.clear();
});

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

	test("warms a relay-only shard without opening a direct or Go route", async () => {
		for (const key of relayEnvKeys) savedRelayEnv.set(key, process.env[key]);
		const urls: string[] = [];
		const relay = Bun.serve({
			port: 0,
			async fetch(request) {
				const payload = (await request.json()) as { url: string };
				urls.push(payload.url);
				return Response.json({ status: 204, headers: {}, bodyBase64: "" });
			},
		});
		try {
			process.env.LINE_RELAY_MODE = "always";
			process.env.LINE_RELAY_URL = `http://127.0.0.1:${relay.port}/dispatch`;
			process.env.LINE_RELAY_TOKEN = "test-token";
			const results = await warmOnce({ url: "http://127.0.0.1:1/dispatch", token: "unused" }, ["legy.line-apps.com", "gf.line.naver.jp"]);
			expect(urls).toEqual(["https://legy.line-apps.com/", "https://gf.line.naver.jp/"]);
			expect(results.every((result) => result.host.startsWith("relay:") && result.status === 204)).toBe(true);
		} finally {
			relay.stop(true);
		}
	});
});
