import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { createBot } from "../bot/bots.ts";

process.env.DISPATCH_TOKEN ??= "worker-proxy-test-token";
const { CONTROL_TOKEN_HEADER, requireControlPlaneForwardOnShard, routeBotOwner } = await import("./worker-proxy.ts");

const ENV_KEYS = [
	"PORT",
	"WORKER_ID",
	"WORKER_OWNER_SCOPE",
	"WORKER_OWNER_EXCLUDE",
	"WORKER_OWNER_ROUTES",
	"CONTROL_PLANE_URL",
	"CONTROL_PLANE_TOKEN",
] as const;
const original = new Map<string, string | undefined>();

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
	for (const key of ENV_KEYS) {
		if (!original.has(key)) original.set(key, process.env[key]);
		const value = values[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = original.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	original.clear();
});

describe("owner worker proxy", () => {
	test("preserves method, query, body, cookie, status and response headers", async () => {
		const owner = 818181;
		const bot = createBot("proxied bot", "DESKTOPWIN", owner);
		let peerHits = 0;
		const peer = Bun.serve({
			port: 0,
			async fetch(request) {
				peerHits++;
				const url = new URL(request.url);
				return Response.json(
					{
						method: request.method,
						path: url.pathname,
						query: url.search,
						body: await request.text(),
						cookie: request.headers.get("cookie"),
						forwarded: request.headers.get("x-linebot-worker-forwarded"),
					},
					{ status: 207, headers: { "set-cookie": "peer=yes; Path=/", "x-peer": "shard-b" } },
				);
			},
		});
		try {
			const token = "p".repeat(32);
			setEnv({
				PORT: "8791",
				WORKER_ID: "primary",
				WORKER_OWNER_EXCLUDE: String(owner),
				WORKER_OWNER_ROUTES: `${owner}=http://127.0.0.1:${peer.port}`,
				CONTROL_PLANE_TOKEN: token,
			});
			const app = new Hono();
			app.use("/api/bots/:botId/*", routeBotOwner);
			app.all("/api/bots/:botId/*", (c) => c.json({ local: true }));

			const response = await app.request(`http://control/api/bots/${bot.id}/rules?q=one`, {
				method: "PATCH",
				headers: { cookie: "session=abc", "content-type": "application/json" },
				body: JSON.stringify({ enabled: true }),
			});
			expect(response.status).toBe(207);
			expect(response.headers.get("x-peer")).toBe("shard-b");
			expect(response.headers.get("set-cookie")).toContain("peer=yes");
			expect(await response.json()).toEqual({
				method: "PATCH",
				path: `/api/bots/${bot.id}/rules`,
				query: "?q=one",
				body: JSON.stringify({ enabled: true }),
				cookie: "session=abc",
				forwarded: "1",
			});
			expect(peerHits).toBe(1);

			const loopResponse = await app.request(`http://control/api/bots/${bot.id}/rules`, {
				headers: {
					"x-linebot-worker-forwarded": "1",
					[CONTROL_TOKEN_HEADER]: token,
				},
			});
			expect(loopResponse.status).toBe(421);
			expect(peerHits).toBe(1);
		} finally {
			peer.stop(true);
		}
	});

	test("keeps an in-scope bot local", async () => {
		const bot = createBot("local bot", "DESKTOPWIN", 828282);
		setEnv({});
		const app = new Hono();
		app.use("/api/bots/:botId/*", routeBotOwner);
		app.get("/api/bots/:botId/ping", (c) => c.json({ local: true }));
		const response = await app.request(`/api/bots/${bot.id}/ping`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ local: true });
	});

	test("a shard rejects direct public API traffic but accepts a trusted forward", async () => {
		const token = "f".repeat(32);
		setEnv({
			WORKER_ID: "shard-b",
			WORKER_OWNER_SCOPE: "2",
			CONTROL_PLANE_URL: "http://127.0.0.1:8791",
			CONTROL_PLANE_TOKEN: token,
		});
		const app = new Hono();
		app.use("/api/*", requireControlPlaneForwardOnShard);
		app.get("/api/ping", (c) => c.json({ ok: true }));
		expect((await app.request("/api/ping")).status).toBe(421);
		expect(
			(
				await app.request("/api/ping", {
					headers: {
						"x-linebot-worker-forwarded": "1",
						[CONTROL_TOKEN_HEADER]: token,
					},
				})
			).status,
		).toBe(200);
	});

	test("returns 503 without falling back locally when the assigned shard is down", async () => {
		const owner = 858585;
		const bot = createBot("unavailable shard bot", "DESKTOPWIN", owner);
		const temporary = Bun.serve({ port: 0, fetch: () => new Response("unused") });
		const deadPort = temporary.port;
		temporary.stop(true);
		setEnv({
			WORKER_ID: "primary",
			WORKER_OWNER_EXCLUDE: String(owner),
			WORKER_OWNER_ROUTES: `${owner}=http://127.0.0.1:${deadPort}`,
			CONTROL_PLANE_TOKEN: "d".repeat(32),
		});
		let ranLocally = false;
		const app = new Hono();
		app.use("/api/bots/:botId/*", routeBotOwner);
		app.get("/api/bots/:botId/ping", (c) => {
			ranLocally = true;
			return c.json({ local: true });
		});
		const errorLog = spyOn(console, "error").mockImplementation(() => {});
		const response = await app.request(`/api/bots/${bot.id}/ping`);
		errorLog.mockRestore();
		expect(response.status).toBe(503);
		expect(ranLocally).toBe(false);
	});
});
