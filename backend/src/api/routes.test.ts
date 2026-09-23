import { beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";

process.env.DISPATCH_TOKEN = "api-route-test-token";

const { authRoute } = await import("./routes/auth.ts");
const { SESSION_COOKIE } = await import("../auth/session.ts");
const { botsRoute } = await import("./routes/bots.ts");
const { botDetailRoute } = await import("./routes/bot-detail.ts");
const { metricsRoute } = await import("./routes/metrics.ts");
const { usersRoute } = await import("./routes/users.ts");
const { isValidSession } = await import("../auth/session.ts");
const { db } = await import("../db/sqlite.ts");

const app = new Hono();
app.route("/api/auth", authRoute);
app.use("/api/bots", requireAuth);
app.use("/api/bots/*", requireAuth);
app.use("/api/metrics/*", requireAuth);
app.use("/api/users", requireAuth);
app.use("/api/users/*", requireAuth);
app.route("/api/bots", botsRoute);
app.route("/api/bots/:botId", botDetailRoute);
app.route("/api/metrics", metricsRoute);
app.route("/api/users", usersRoute);

let cookie = "";
let adminCookie = "";
let botId = 0;

async function requireAuth(c: Context, next: Next) {
	const token = getCookie(c, SESSION_COOKIE);
	if (!isValidSession(token)) return c.json({ error: "unauthorized" }, 401);
	await next();
}

function request(path: string, init: RequestInit = {}): Promise<Response> {
	return Promise.resolve(
		app.request(path, {
			...init,
			headers: {
				...(init.body ? { "content-type": "application/json" } : {}),
				...(cookie ? { cookie } : {}),
				...init.headers,
			},
		}),
	);
}

beforeAll(async () => {
	db.exec("DELETE FROM kv; DELETE FROM bots; DELETE FROM rules; DELETE FROM chats; DELETE FROM latency_samples;");
	const login = await request("/api/auth/login", {
		method: "POST",
		body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }),
	});
	expect(login.status).toBe(200);
	const sessionCookie = login.headers.get("set-cookie") ?? "";
	expect(sessionCookie).toContain(`${SESSION_COOKIE}=`);
	expect(sessionCookie).toContain("HttpOnly");
	expect(sessionCookie).toContain("SameSite=Strict");
	expect(sessionCookie).toContain("Max-Age=43200");
	cookie = sessionCookie.split(";", 1)[0] ?? "";
	adminCookie = cookie;
});

describe("API routes", () => {
	test("requires authentication", async () => {
		const activeCookie = cookie;
		cookie = "";
		expect((await request("/api/bots")).status).toBe(401);
		cookie = activeCookie;
	});

	test("validates and creates a bot", async () => {
		expect((await request("/api/bots", { method: "POST", body: "{bad" })).status).toBe(400);
		expect(
			(
				await request("/api/bots", {
					method: "POST",
					body: JSON.stringify({ name: "bad device", device: "INVALID" }),
				})
			).status,
		).toBe(400);

		const response = await request("/api/bots", {
			method: "POST",
			body: JSON.stringify({ name: "E2E bot", device: "DESKTOPWIN" }),
		});
		expect(response.status).toBe(201);
		const bot = (await response.json()) as { id: number; allowOwnerTesting: boolean };
		botId = bot.id;
		expect(bot.allowOwnerTesting).toBe(false);

		const reordered = await request("/api/bots/order", {
			method: "PUT",
			body: JSON.stringify({ botIds: [botId] }),
		});
		expect(reordered.status).toBe(200);
		expect(((await reordered.json()) as Array<{ id: number }>).map((item) => item.id)).toEqual([botId]);
		expect(
			(
				await request("/api/bots/order", {
					method: "PUT",
					body: JSON.stringify({ botIds: [botId, botId] }),
				})
			).status,
		).toBe(400);
	});

	test("updates owner testing and validates rule CRUD", async () => {
		const setting = await request(`/api/bots/${botId}/settings`, {
			method: "PATCH",
			body: JSON.stringify({ allowOwnerTesting: true }),
		});
		expect(setting.status).toBe(200);
		expect(((await setting.json()) as { allowOwnerTesting: boolean }).allowOwnerTesting).toBe(true);

		const invalidRule = {
			surface: "invalid",
			matchType: "equals",
			matchValue: "14",
			replyText: "bad",
			enabled: true,
			priority: 0,
		};
		expect(
			(
				await request(`/api/bots/${botId}/rules`, {
					method: "POST",
					body: JSON.stringify(invalidRule),
				})
			).status,
		).toBe(400);

		for (const surface of ["talk", "square"]) {
			const response = await request(`/api/bots/${botId}/rules`, {
				method: "POST",
				body: JSON.stringify({ ...invalidRule, surface, replyText: `${surface}-ok` }),
			});
			expect(response.status).toBe(201);
		}

		const rules = (await (await request(`/api/bots/${botId}/rules`)).json()) as unknown[];
		expect(rules).toHaveLength(2);
		expect(
			(
				await request(`/api/bots/${botId}/rules/999999`, {
					method: "PUT",
					body: JSON.stringify({ ...invalidRule, surface: "talk" }),
				})
			).status,
		).toBe(404);
		expect((await request(`/api/bots/${botId}/rules/999999`, { method: "DELETE" })).status).toBe(404);
	});

	test("qr endpoint only ever returns data while the bot is connecting", async () => {
		// A REST fallback for the qr/pincode WS events (which only ever fire
		// once) — a freshly created bot is "offline", so nothing is pending yet.
		const response = await request(`/api/bots/${botId}/qr`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({});
	});

	test("rejects invalid send targets and bounds metric limits", async () => {
		expect(
			(
				await request(`/api/bots/${botId}/test-send`, {
					method: "POST",
					body: JSON.stringify({ surface: "square", targetMid: "bad", text: "x" }),
				})
			).status,
		).toBe(400);
		expect((await request("/api/metrics/history?limit=-5")).status).toBe(200);
		expect((await request("/api/metrics/fast-path?limit=99999")).status).toBe(200);
	});

	test("includes persisted latency breakdowns in the admin lane history", async () => {
		cookie = adminCookie;
		const ts = Date.now();
		db.run(
			`INSERT INTO latency_samples (
			bot_id, ts, surface, target_mid, latency_ms, ok, source, text_preview,
			inbound_ms, line_created_time, line_ms, code_ms, decrypt_ms, match_ms,
			limiter_ms, routing_ms, protocol_prep_ms, relay_encode_ms, go_prep_ms,
			relay_and_parse_ms, upstream_calls
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[botId, ts, "square", null, 18.5, 1, "auto", "answer", 4.2, ts, 14, 4.5, 0.1, 0.1, 0.1, 0.2, 2.5, 0.1, 0.2, 1.2, 1],
		);
		try {
			const response = await request("/api/metrics/lane-race");
			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				latency: Array<{ botId: number; latencyMs: number; breakdown?: { lineMs: number; routingMs: number } }>;
			};
			const sample = body.latency.find((entry) => entry.botId === botId && entry.latencyMs === 18.5);
			expect(sample?.breakdown).toMatchObject({ lineMs: 14, routingMs: 0.2 });
		} finally {
			db.run("DELETE FROM latency_samples WHERE bot_id = ? AND ts = ?", [botId, ts]);
		}
	});

	test("deletes a bot and returns 404 afterward", async () => {
		expect((await request(`/api/bots/${botId}`, { method: "DELETE" })).status).toBe(200);
		expect((await request(`/api/bots/${botId}/rules`)).status).toBe(404);
	});

	test("isolates each user's bots and lets admin stop the account", async () => {
		cookie = adminCookie;
		const aliceResponse = await request("/api/users", {
			method: "POST",
			body: JSON.stringify({ username: "alice", password: "alice-secure-123" }),
		});
		expect(aliceResponse.status).toBe(201);
		const alice = (await aliceResponse.json()) as { id: number };
		expect(
			(
				await request("/api/users", {
					method: "POST",
					body: JSON.stringify({ username: "bob", password: "bob-secure-123" }),
				})
			).status,
		).toBe(201);

		const aliceLogin = await request("/api/auth/login", {
			method: "POST",
			body: JSON.stringify({ username: "alice", password: "alice-secure-123" }),
		});
		cookie = aliceLogin.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
		const aliceBotResponse = await request("/api/bots", {
			method: "POST",
			body: JSON.stringify({ name: "Alice bot" }),
		});
		const aliceBot = (await aliceBotResponse.json()) as { id: number; ownerUserId: number };
		expect(aliceBot.ownerUserId).toBe(alice.id);
		expect((await (await request("/api/bots")).json()) as unknown[]).toHaveLength(1);
		expect((await request("/api/users")).status).toBe(403);

		const bobLogin = await request("/api/auth/login", {
			method: "POST",
			body: JSON.stringify({ username: "bob", password: "bob-secure-123" }),
		});
		cookie = bobLogin.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
		expect((await (await request("/api/bots")).json()) as unknown[]).toHaveLength(0);
		expect((await request(`/api/bots/${aliceBot.id}/rules`)).status).toBe(403);

		cookie = adminCookie;
		expect((await (await request("/api/bots")).json()) as unknown[]).toHaveLength(1);
		expect(
			(
				await request(`/api/users/${alice.id}`, {
					method: "PATCH",
					body: JSON.stringify({ active: false }),
				})
			).status,
		).toBe(200);
		const stoppedLogin = await request("/api/auth/login", {
			method: "POST",
			body: JSON.stringify({ username: "alice", password: "alice-secure-123" }),
		});
		expect(stoppedLogin.status).toBe(401);
		cookie = adminCookie;
	});

	test("holds a user to their bot quota until an admin raises it", async () => {
		cookie = adminCookie;
		const created = await request("/api/users", {
			method: "POST",
			body: JSON.stringify({ username: "carol", password: "carol-secure-123" }),
		});
		const carol = (await created.json()) as { id: number; botQuota: number };
		expect(carol.botQuota).toBe(1);

		const carolLogin = await request("/api/auth/login", {
			method: "POST",
			body: JSON.stringify({ username: "carol", password: "carol-secure-123" }),
		});
		cookie = carolLogin.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

		const carol1Response = await request("/api/bots", { method: "POST", body: JSON.stringify({ name: "carol 1" }) });
		expect(carol1Response.status).toBe(201);
		const carol1 = (await carol1Response.json()) as { id: number; rulesCopiedFrom: number };
		expect(carol1.rulesCopiedFrom).toBe(0); // no sibling exists yet to copy from
		await request(`/api/bots/${carol1.id}/rules`, {
			method: "POST",
			body: JSON.stringify({
				surface: "all",
				matchType: "equals",
				matchValue: "หวัดดี",
				replyText: "หวัดดีครับ",
				enabled: true,
				priority: 0,
			}),
		});

		const blocked = await request("/api/bots", { method: "POST", body: JSON.stringify({ name: "carol 2" }) });
		expect(blocked.status).toBe(403);
		const blockedBody = (await blocked.json()) as { quota: number; pricePerMonthThb: number };
		expect(blockedBody.quota).toBe(1);
		expect(blockedBody.pricePerMonthThb).toBe(100);

		// A user cannot lift their own ceiling.
		expect(
			(
				await request(`/api/users/${carol.id}`, {
					method: "PATCH",
					body: JSON.stringify({ botQuota: 5 }),
				})
			).status,
		).toBe(403);

		cookie = adminCookie;
		const raised = await request(`/api/users/${carol.id}`, {
			method: "PATCH",
			body: JSON.stringify({ botQuota: 3 }),
		});
		expect(raised.status).toBe(200);
		expect(((await raised.json()) as { botQuota: number }).botQuota).toBe(3);
		expect(
			(
				await request(`/api/users/${carol.id}`, {
					method: "PATCH",
					body: JSON.stringify({ botQuota: 6 }),
				})
			).status,
		).toBe(400);

		cookie = carolLogin.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
		const carol2Response = await request("/api/bots", { method: "POST", body: JSON.stringify({ name: "carol 2" }) });
		expect(carol2Response.status).toBe(201);
		const carol2 = (await carol2Response.json()) as { id: number; rulesCopiedFrom: number };
		// carol 1 is the only sibling and had one rule — it copies straight over.
		expect(carol2.rulesCopiedFrom).toBe(1);
		const carol2Rules = (await (await request(`/api/bots/${carol2.id}/rules`)).json()) as Array<{ matchValue: string }>;
		expect(carol2Rules.map((r) => r.matchValue)).toEqual(["หวัดดี"]);

		expect((await request("/api/bots", { method: "POST", body: JSON.stringify({ name: "carol 3" }) })).status).toBe(201);
		expect((await request("/api/bots", { method: "POST", body: JSON.stringify({ name: "carol 4" }) })).status).toBe(403);

		const me = (await (await request("/api/auth/me")).json()) as { botQuota: number; botPricePerMonthThb: number };
		expect(me.botQuota).toBe(3);
		expect(me.botPricePerMonthThb).toBe(100);
		cookie = adminCookie;
	});

	test("changes a password, revokes older sessions, and keeps the caller signed in", async () => {
		cookie = adminCookie;
		const created = await request("/api/users", {
			method: "POST",
			body: JSON.stringify({ username: "grace", password: "grace-old-secure-123" }),
		});
		expect(created.status).toBe(201);

		const login = await request("/api/auth/login", {
			method: "POST",
			body: JSON.stringify({ username: "grace", password: "grace-old-secure-123" }),
		});
		const oldCookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
		cookie = oldCookie;
		const changed = await request("/api/auth/change-password", {
			method: "POST",
			body: JSON.stringify({ currentPassword: "grace-old-secure-123", newPassword: "grace-new-secure-456" }),
		});
		expect(changed.status).toBe(200);
		const newCookie = changed.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
		expect(newCookie).not.toBe(oldCookie);

		cookie = oldCookie;
		expect((await request("/api/bots")).status).toBe(401);
		cookie = newCookie;
		expect((await request("/api/bots")).status).toBe(200);
		expect(
			(
				await request("/api/auth/login", {
					method: "POST",
					body: JSON.stringify({ username: "grace", password: "grace-old-secure-123" }),
				})
			).status,
		).toBe(401);
		expect(
			(
				await request("/api/auth/login", {
					method: "POST",
					body: JSON.stringify({ username: "grace", password: "grace-new-secure-456" }),
				})
			).status,
		).toBe(200);
		cookie = adminCookie;
	});
});
