import { describe, expect, test } from "bun:test";
import { createDispatchFetch } from "./client.ts";
import { getHotLineFetch, getHotLinePrewarmFetch } from "./direct-request.ts";
import { readResponseBytes } from "./raw-response.ts";

describe("direct LINE transport", () => {
	test("sends the prebuilt request without Go and retains raw bytes", async () => {
		const previous = process.env.LINE_TRANSPORT;
		delete process.env.LINE_TRANSPORT;
		const server = Bun.serve({
			port: 0,
			fetch: async (request) => new Response(await request.arrayBuffer(), {
				status: 201,
				headers: { "x-test": "direct" },
			}),
		});
		try {
			const fetchLine = createDispatchFetch({ url: "http://127.0.0.1:1/dispatch", token: "unused" });
			const response = await fetchLine(new Request(`http://127.0.0.1:${server.port}/CA5`, {
				method: "POST",
				body: new Uint8Array([7, 8, 9]),
			}));
			expect(response.status).toBe(201);
			expect(response.headers.get("x-test")).toBe("direct");
			expect(await readResponseBytes(response)).toEqual(new Uint8Array([7, 8, 9]));
		} finally {
			server.stop(true);
			if (previous === undefined) delete process.env.LINE_TRANSPORT;
			else process.env.LINE_TRANSPORT = previous;
		}
	});

	test("exposes a hot fetch that skips wrapper Request allocation", async () => {
		const previous = process.env.LINE_TRANSPORT;
		delete process.env.LINE_TRANSPORT;
		const server = Bun.serve({
			port: 0,
			fetch: async (request) => new Response(await request.arrayBuffer(), { status: 200 }),
		});
		try {
			const fetchLine = createDispatchFetch({ url: "http://127.0.0.1:1/dispatch", token: "unused" });
			const hotFetch = getHotLineFetch(fetchLine);
			expect(hotFetch).toBeDefined();
			const response = await hotFetch!(`http://127.0.0.1:${server.port}/CA5`, {
				method: "POST",
				body: new Uint8Array([4, 5, 6]) as BodyInit,
			});
			expect(await readResponseBytes(response)).toEqual(new Uint8Array([4, 5, 6]));
		} finally {
			server.stop(true);
			if (previous === undefined) delete process.env.LINE_TRANSPORT;
			else process.env.LINE_TRANSPORT = previous;
		}
	});

	test("prewarm transport returns a RAM ACK without touching the network", async () => {
		const fetchLine = createDispatchFetch({
			url: "http://127.0.0.1:1/dispatch",
			token: "unused",
		});
		const prewarmFetch = getHotLinePrewarmFetch(fetchLine);
		expect(prewarmFetch).toBeDefined();
		const talk = await prewarmFetch!("http://127.0.0.1:1/CA5", {
			method: "POST",
			body: new Uint8Array([1]) as BodyInit,
		});
		const square = await prewarmFetch!("http://127.0.0.1:1/SQ1", {
			method: "POST",
			body: new Uint8Array([1]) as BodyInit,
		});
		expect(await readResponseBytes(talk)).toEqual(Uint8Array.of(1));
		expect((await readResponseBytes(square))[0]).toBe(0x82);
	});
});
