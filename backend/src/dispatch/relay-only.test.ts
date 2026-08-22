import { afterEach, describe, expect, test } from "bun:test";
import { laneFetch } from "./h2-lanes.ts";

const saved = new Map<string, string | undefined>();
const ENV_KEYS = ["LINE_RELAY_MODE", "LINE_RELAY_URL", "LINE_RELAY_TOKEN"] as const;

function setRelay(url: string): void {
	for (const key of ENV_KEYS) saved.set(key, process.env[key]);
	process.env.LINE_RELAY_MODE = "always";
	process.env.LINE_RELAY_URL = url;
	process.env.LINE_RELAY_TOKEN = "test-relay-token";
}

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = saved.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	saved.clear();
});

describe("relay-only lane transport", () => {
	test("sends exactly once through the pinned relay without a local lane", async () => {
		let calls = 0;
		let relayedUrl = "";
		const relay = Bun.serve({
			port: 0,
			async fetch(request) {
				calls++;
				const payload = (await request.json()) as { url: string };
				relayedUrl = payload.url;
				return Response.json({
					status: 201,
					headers: { "x-relayed": "1" },
					bodyBase64: Buffer.from("ok").toString("base64"),
				});
			},
		});
		try {
			setRelay(`http://127.0.0.1:${relay.port}/dispatch`);
			const response = await laneFetch("https://legy.line-apps.com/SQ1", { method: "POST", body: "body" });
			expect(calls).toBe(1);
			expect(relayedUrl).toBe("https://legy.line-apps.com/SQ1");
			expect(response?.status).toBe(201);
			expect(response?.headers.get("x-relayed")).toBe("1");
			expect(await response?.text()).toBe("ok");
		} finally {
			relay.stop(true);
		}
	});

	test("keeps login/control origins on Server 2 instead of relaying them", async () => {
		let calls = 0;
		const relay = Bun.serve({ port: 0, fetch: () => (calls++, new Response("unexpected")) });
		try {
			setRelay(`http://127.0.0.1:${relay.port}/dispatch`);
			const response = await laneFetch("https://gf.line.naver.jp/enc", { method: "POST", body: "login-control" });
			expect(response).toBeUndefined();
			expect(calls).toBe(0);
		} finally {
			relay.stop(true);
		}
	});

	test("fails closed when the pinned relay is unavailable", async () => {
		const closed = Bun.serve({ port: 0, fetch: () => new Response("unused") });
		const url = `http://127.0.0.1:${closed.port}/dispatch`;
		closed.stop(true);
		setRelay(url);
		await expect(laneFetch("https://legy.line-apps.com/SQ1", { method: "POST" })).rejects.toThrow("lane relay unavailable");
	});

	test("does not retry after the relay accepted a request and returned an upstream error", async () => {
		let calls = 0;
		const relay = Bun.serve({
			port: 0,
			fetch() {
				calls++;
				return new Response("upstream failed", { status: 502 });
			},
		});
		try {
			setRelay(`http://127.0.0.1:${relay.port}/dispatch`);
			await expect(laneFetch("https://legy.line-apps.com/SQ1", { method: "POST" })).rejects.toThrow("HTTP 502");
			expect(calls).toBe(1);
		} finally {
			relay.stop(true);
		}
	});

	test("carries a full concurrent fleet without merging or duplicating requests", async () => {
		const received = new Set<string>();
		let calls = 0;
		const relay = Bun.serve({
			port: 0,
			async fetch(request) {
				calls++;
				const payload = (await request.json()) as { url: string };
				received.add(payload.url);
				return Response.json({ status: 200, headers: {}, bodyBase64: "" });
			},
		});
		try {
			setRelay(`http://127.0.0.1:${relay.port}/dispatch`);
			const count = 32;
			const responses = await Promise.all(
				Array.from({ length: count }, (_, index) => laneFetch(`https://legy.line-apps.com/SQ1?request=${index}`, { method: "POST" })),
			);
			expect(responses.every((response) => response?.ok)).toBe(true);
			expect(calls).toBe(count);
			expect(received.size).toBe(count);
		} finally {
			relay.stop(true);
		}
	});
});
