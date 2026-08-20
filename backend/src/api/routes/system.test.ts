import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { createSession, getSessionUser, SESSION_COOKIE } from "../../auth/session.ts";
import { createUser } from "../../auth/users.ts";
import { db } from "../../db/sqlite.ts";
import { createSystemRoute } from "./system.ts";

async function requireAuth(c: Context, next: Next) {
	const token = getCookie(c, SESSION_COOKIE);
	if (!getSessionUser(token)) return c.json({ error: "unauthorized" }, 401);
	await next();
}

function buildApp(restartAvailable = true, onSchedule: (delayMs: number) => void = () => {}) {
	const app = new Hono();
	app.use("/api/system/*", requireAuth);
	app.route(
		"/api/system",
		createSystemRoute({
			isShardWorker: () => false,
			restartAvailable: () => restartAvailable,
			scheduleRestart: onSchedule,
		}),
	);
	return app;
}

function restartRequest(app: Hono, cookie = "", confirm = "restart-linebot-worker") {
	return app.request("/api/system/restart-worker", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(cookie ? { cookie } : {}),
		},
		body: JSON.stringify({ confirm }),
	});
}

beforeEach(() => {
	db.prepare("DELETE FROM app_meta WHERE key = 'system.worker.last_restart_requested_at'").run();
	db.prepare("DELETE FROM app_meta WHERE key = 'hedge.send.config'").run();
	db.prepare("DELETE FROM app_meta WHERE key = 'system.maintenance_mode'").run();
	db.prepare("DELETE FROM lane_race_events").run();
});

describe("POST /api/system/restart-worker", () => {
	test("requires authentication and an admin role", async () => {
		const app = buildApp();
		expect((await restartRequest(app)).status).toBe(401);

		const user = createUser(`restart-user-${Date.now()}`, "restart-test-password");
		const userCookie = `${SESSION_COOKIE}=${createSession(user.id)}`;
		expect((await restartRequest(app, userCookie)).status).toBe(403);
	});

	test("requires explicit confirmation and a systemd-managed worker", async () => {
		const adminCookie = `${SESSION_COOKIE}=${createSession()}`;
		expect((await restartRequest(buildApp(), adminCookie, "wrong")).status).toBe(400);
		expect((await restartRequest(buildApp(false), adminCookie)).status).toBe(503);
	});

	test("schedules one process restart and enforces the persistent cooldown", async () => {
		const adminCookie = `${SESSION_COOKIE}=${createSession()}`;
		const delays: number[] = [];
		const app = buildApp(true, (delayMs) => delays.push(delayMs));
		const response = await restartRequest(app, adminCookie);
		expect(response.status).toBe(202);
		const body = (await response.json()) as { ok: boolean; unit: string; requestedAt: number };
		expect(body.ok).toBe(true);
		expect(body.unit).toBe("linebot-worker.service");
		expect(delays).toEqual([2_000]);

		const repeated = await restartRequest(app, adminCookie);
		expect(repeated.status).toBe(429);
		expect(Number(repeated.headers.get("retry-after"))).toBeGreaterThan(0);
	});
});

describe("/api/system/hedge", () => {
	function hedgeRequest(app: Hono, cookie = "", config?: unknown) {
		return app.request("/api/system/hedge", {
			method: config === undefined ? "GET" : "PUT",
			headers: {
				"content-type": "application/json",
				...(cookie ? { cookie } : {}),
			},
			...(config === undefined ? {} : { body: JSON.stringify(config) }),
		});
	}

	test("requires authentication and an admin role", async () => {
		const app = buildApp();
		expect((await hedgeRequest(app)).status).toBe(401);

		const user = createUser(`hedge-user-${Date.now()}`, "hedge-test-password");
		const userCookie = `${SESSION_COOKIE}=${createSession(user.id)}`;
		expect((await hedgeRequest(app, userCookie)).status).toBe(403);
	});

	test("PUT validates the payload and rejects mode on", async () => {
		const app = buildApp();
		const adminCookie = `${SESSION_COOKIE}=${createSession()}`;
		const badMode = await hedgeRequest(app, adminCookie, { mode: "on", delayMs: 14, slowMs: 23 });
		expect(badMode.status).toBe(400);
		const badDelay = await hedgeRequest(app, adminCookie, { mode: "shadow", delayMs: 50, slowMs: 60 });
		expect(badDelay.status).toBe(400);
		const notJson = await app.request("/api/system/hedge", {
			method: "PUT",
			headers: { "content-type": "application/json", cookie: adminCookie },
			body: "not-json",
		});
		expect(notJson.status).toBe(400);
	});

	test("PUT applies the config and GET reports it back with shadow stats", async () => {
		const app = buildApp();
		const adminCookie = `${SESSION_COOKIE}=${createSession()}`;
		const put = await hedgeRequest(app, adminCookie, { mode: "shadow", delayMs: 14, slowMs: 23 });
		expect(put.status).toBe(200);
		const putBody = (await put.json()) as { ok: boolean; config: { mode: string } };
		expect(putBody.ok).toBe(true);
		expect(putBody.config.mode).toBe("shadow");

		const get = await hedgeRequest(app, adminCookie);
		expect(get.status).toBe(200);
		const report = (await get.json()) as {
			config: { mode: string; delayMs: number; slowMs: number };
			windowHours: number;
			totalSamples: number;
			workers: unknown[];
		};
		expect(report.config).toEqual({ mode: "shadow", delayMs: 14, slowMs: 23 });
		expect(report.windowHours).toBe(24);
		expect(report.totalSamples).toBe(0);
		expect(report.workers).toEqual([]);
	});
});

describe("/api/system/maintenance-mode", () => {
	function maintenanceRequest(app: Hono, cookie = "", enabled?: boolean) {
		return app.request("/api/system/maintenance-mode", {
			method: enabled === undefined ? "GET" : "PUT",
			headers: {
				"content-type": "application/json",
				...(cookie ? { cookie } : {}),
			},
			...(enabled === undefined ? {} : { body: JSON.stringify({ enabled }) }),
		});
	}

	test("requires authentication and an admin role", async () => {
		const app = buildApp();
		expect((await maintenanceRequest(app)).status).toBe(401);

		const user = createUser(`maintenance-user-${Date.now()}`, "maintenance-test-password");
		const userCookie = `${SESSION_COOKIE}=${createSession(user.id)}`;
		expect((await maintenanceRequest(app, userCookie)).status).toBe(403);
	});

	test("GET defaults to off, PUT rejects a non-boolean payload", async () => {
		const app = buildApp();
		const adminCookie = `${SESSION_COOKIE}=${createSession()}`;
		const get = await maintenanceRequest(app, adminCookie);
		expect(get.status).toBe(200);
		expect(await get.json()).toEqual({ enabled: false });

		const badBody = await app.request("/api/system/maintenance-mode", {
			method: "PUT",
			headers: { "content-type": "application/json", cookie: adminCookie },
			body: JSON.stringify({ enabled: "yes" }),
		});
		expect(badBody.status).toBe(400);
	});

	test("PUT persists the flag and GET reflects it back", async () => {
		const app = buildApp();
		const adminCookie = `${SESSION_COOKIE}=${createSession()}`;

		const on = await maintenanceRequest(app, adminCookie, true);
		expect(on.status).toBe(200);
		expect(await on.json()).toEqual({ ok: true, enabled: true });
		expect(await (await maintenanceRequest(app, adminCookie)).json()).toEqual({ enabled: true });

		const off = await maintenanceRequest(app, adminCookie, false);
		expect(off.status).toBe(200);
		expect(await off.json()).toEqual({ ok: true, enabled: false });
		expect(await (await maintenanceRequest(app, adminCookie)).json()).toEqual({ enabled: false });
	});
});

describe("/api/system/hard-timeout-test", () => {
	const VALID_MID = `m${"a".repeat(32)}`;
	const VALID_BODY = { confirm: "test-hard-timeout", botId: 1, targetMid: VALID_MID, count: 3, timeoutMs: 20 };

	function hardTimeoutRequest(app: Hono, cookie = "", body: Record<string, unknown> = VALID_BODY) {
		return app.request("/api/system/hard-timeout-test", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(cookie ? { cookie } : {}),
			},
			body: JSON.stringify(body),
		});
	}

	test("requires authentication and an admin role", async () => {
		const app = buildApp();
		expect((await hardTimeoutRequest(app)).status).toBe(401);

		const user = createUser(`hard-timeout-user-${Date.now()}`, "hard-timeout-test-password");
		const userCookie = `${SESSION_COOKIE}=${createSession(user.id)}`;
		expect((await hardTimeoutRequest(app, userCookie)).status).toBe(403);
	});

	test("rejects a missing or wrong confirm string", async () => {
		const app = buildApp();
		const adminCookie = `${SESSION_COOKIE}=${createSession()}`;
		expect((await hardTimeoutRequest(app, adminCookie, { ...VALID_BODY, confirm: undefined })).status).toBe(400);
		expect((await hardTimeoutRequest(app, adminCookie, { ...VALID_BODY, confirm: "nope" })).status).toBe(400);
	});

	test("validates botId, targetMid, count, and timeoutMs", async () => {
		const app = buildApp();
		const adminCookie = `${SESSION_COOKIE}=${createSession()}`;
		expect((await hardTimeoutRequest(app, adminCookie, { ...VALID_BODY, botId: 0 })).status).toBe(400);
		expect((await hardTimeoutRequest(app, adminCookie, { ...VALID_BODY, targetMid: "not-a-square-mid" })).status).toBe(400);
		expect((await hardTimeoutRequest(app, adminCookie, { ...VALID_BODY, count: 0 })).status).toBe(400);
		expect((await hardTimeoutRequest(app, adminCookie, { ...VALID_BODY, count: 31 })).status).toBe(400);
		expect((await hardTimeoutRequest(app, adminCookie, { ...VALID_BODY, timeoutMs: 0 })).status).toBe(400);
		expect((await hardTimeoutRequest(app, adminCookie, { ...VALID_BODY, timeoutMs: 501 })).status).toBe(400);
	});

	test("defaults timeoutMs to 20 when omitted", async () => {
		const app = buildApp();
		const adminCookie = `${SESSION_COOKIE}=${createSession()}`;
		const { timeoutMs, ...withoutTimeout } = VALID_BODY;
		const res = await hardTimeoutRequest(app, adminCookie, withoutTimeout);
		// No live bot session in this test, so the request fails past
		// validation -- proving timeoutMs's absence alone did not 400.
		expect(res.status).toBe(400);
		expect((await res.json() as { error: string }).error).toContain("เข้าสู่ระบบ");
	});

	test("surfaces an error when the bot has no live session", async () => {
		const app = buildApp();
		const adminCookie = `${SESSION_COOKIE}=${createSession()}`;
		const res = await hardTimeoutRequest(app, adminCookie);
		expect(res.status).toBe(400);
		expect((await res.json() as { error: string }).error).toContain("เข้าสู่ระบบ");
	});
});
