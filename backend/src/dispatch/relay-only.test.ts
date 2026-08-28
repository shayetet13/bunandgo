import { afterEach, describe, expect, test } from "bun:test";
import { H2_LANE_ROLE_HEADER, laneFetch } from "./h2-lanes.ts";
import { resetRemoteLaneStateForTest, updateRemoteLaneFromReport } from "./remote-lane.ts";

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

	test("hybrid mode: POLL may offload to the relay but SEND stays local unless LINE_RELAY_SEND=1", async () => {
		const prevMode = process.env.LINE_RELAY_MODE;
		const prevLanes = process.env.LINE_H2_LANES;
		const prevSend = process.env.LINE_RELAY_SEND;
		let calls: Array<{ url: string; role?: string }> = [];
		const relay = Bun.serve({
			port: 0,
			async fetch(request) {
				const payload = (await request.json()) as { url: string; role?: string };
				calls.push({ url: payload.url, role: payload.role });
				return Response.json({ status: 200, headers: {}, bodyBase64: "" });
			},
		});
		try {
			for (const key of ENV_KEYS) saved.set(key, process.env[key]);
			delete process.env.LINE_RELAY_MODE; // hybrid, not relay-only
			process.env.LINE_RELAY_URL = `http://127.0.0.1:${relay.port}/dispatch`;
			process.env.LINE_RELAY_TOKEN = "test-relay-token";
			process.env.LINE_H2_LANES = "0"; // no local lane, so any relay dispatch is visible
			resetRemoteLaneStateForTest();
			updateRemoteLaneFromReport("https://legy.line-apps.com", { pingRttMs: 6, pollRttMs: 12, pollSampleAt: Date.now() }, Date.now());

			delete process.env.LINE_RELAY_SEND;
			await laneFetch("https://legy.line-apps.com/POLL", { method: "POST", headers: { [H2_LANE_ROLE_HEADER]: "poll" } });
			expect(calls.map((c) => c.role)).toEqual(["poll"]);
			await laneFetch("https://legy.line-apps.com/SEND", { method: "POST" });
			expect(calls.length).toBe(1); // SEND did not reach the relay

			calls = [];
			process.env.LINE_RELAY_SEND = "1";
			resetRemoteLaneStateForTest();
			updateRemoteLaneFromReport("https://legy.line-apps.com", { pingRttMs: 6, sendRttMs: 15, sendSampleAt: Date.now() }, Date.now());
			await laneFetch("https://legy.line-apps.com/SEND", { method: "POST" });
			expect(calls.map((c) => c.role)).toEqual(["send"]);
		} finally {
			relay.stop(true);
			resetRemoteLaneStateForTest();
			if (prevMode === undefined) delete process.env.LINE_RELAY_MODE;
			else process.env.LINE_RELAY_MODE = prevMode;
			if (prevLanes === undefined) delete process.env.LINE_H2_LANES;
			else process.env.LINE_H2_LANES = prevLanes;
			if (prevSend === undefined) delete process.env.LINE_RELAY_SEND;
			else process.env.LINE_RELAY_SEND = prevSend;
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
