import { describe, expect, test } from "bun:test";
import type { BaseClient } from "../core/mod.ts";
import { RequestClient } from "./mod.ts";

function makeClient(options: { hotError: Error; regularError: Error; calls: { hot: number; regular: number } }): BaseClient {
	return {
		deviceDetails: {
			device: "DESKTOPWIN",
			appVersion: "1.0.0",
			systemName: "WINDOWS",
			systemVersion: "10.0",
		},
		endpoint: "legy.line-apps.com",
		config: { timeout: 1_000 },
		disabled: false,
		debugLogsEnabled: false,
		legy: { encrypted: false, endpoint: "https://gf.line.naver.jp/enc" },
		thrift: {
			writeThrift: () => new Uint8Array([1, 2, 3]),
		},
		fetchHot: async () => {
			options.calls.hot++;
			throw options.hotError;
		},
		fetch: async () => {
			options.calls.regular++;
			throw options.regularError;
		},
	} as unknown as BaseClient;
}

describe("RequestClient Square hot transport", () => {
	test("uses the hot lane for a full-result /SQ1 sendMessage", async () => {
		const hotError = new Error("hot route selected");
		const regularError = new Error("regular route selected");
		const calls = { hot: 0, regular: 0 };
		const request = new RequestClient(makeClient({ hotError, regularError, calls }));

		await expect(request.request([], "sendMessage", 3, true, "/SQ1")).rejects.toBe(hotError);
		expect(calls).toEqual({ hot: 1, regular: 0 });
	});

	test("uses the hot lane for latency-sensitive per-room Square polling", async () => {
		const hotError = new Error("hot route selected");
		const regularError = new Error("regular route selected");
		const calls = { hot: 0, regular: 0 };
		const request = new RequestClient(makeClient({ hotError, regularError, calls }));

		await expect(request.request([], "fetchSquareChatEvents", 3, true, "/SQ1")).rejects.toBe(hotError);
		expect(calls).toEqual({ hot: 1, regular: 0 });
	});

	test("uses the hot lane for fetchMyEvents, the push connection's own event retrieval", async () => {
		const hotError = new Error("hot route selected");
		const regularError = new Error("regular route selected");
		const calls = { hot: 0, regular: 0 };
		const request = new RequestClient(makeClient({ hotError, regularError, calls }));

		await expect(request.request([], "fetchMyEvents", 3, true, "/SQ1")).rejects.toBe(hotError);
		expect(calls).toEqual({ hot: 1, regular: 0 });
	});

	test("keeps an ordinary full-result Square RPC on the regular transport", async () => {
		const hotError = new Error("hot route selected");
		const regularError = new Error("regular route selected");
		const calls = { hot: 0, regular: 0 };
		const request = new RequestClient(makeClient({ hotError, regularError, calls }));

		await expect(request.request([], "getSquare", 3, true, "/SQ1")).rejects.toBe(regularError);
		expect(calls).toEqual({ hot: 0, regular: 1 });
	});
});

describe("RFC 9218 request priority", () => {
	function makePriorityCapturingClient(): { client: BaseClient; headersSeen: Headers[] } {
		const headersSeen: Headers[] = [];
		const client = {
			deviceDetails: {
				device: "DESKTOPWIN",
				appVersion: "1.0.0",
				systemName: "WINDOWS",
				systemVersion: "10.0",
			},
			endpoint: "legy.line-apps.com",
			config: { timeout: 1_000 },
			disabled: false,
			debugLogsEnabled: false,
			legy: { encrypted: false, endpoint: "https://gf.line.naver.jp/enc" },
			thrift: {
				writeThrift: () => new Uint8Array([1, 2, 3]),
			},
			fetchHot: async (_info: RequestInfo | URL, init?: RequestInit) => {
				headersSeen.push(new Headers(init?.headers));
				throw new Error("stop before the network");
			},
			fetch: async () => {
				throw new Error("should not use the regular transport");
			},
		} as unknown as BaseClient;
		return { client, headersSeen };
	}

	test("marks a SEND the most urgent priority the RFC allows", async () => {
		const { client, headersSeen } = makePriorityCapturingClient();
		const request = new RequestClient(client);

		await expect(request.request([], "sendMessage", 3, true, "/SQ1")).rejects.toThrow();
		expect(headersSeen[0]?.get("priority")).toBe("u=0");
	});

	test("marks poll traffic low, incremental priority so it never outranks a SEND", async () => {
		const { client, headersSeen } = makePriorityCapturingClient();
		const request = new RequestClient(client);

		await expect(request.request([], "fetchSquareChatEvents", 3, true, "/SQ1")).rejects.toThrow();
		expect(headersSeen[0]?.get("priority")).toBe("u=7, i");
	});
});
