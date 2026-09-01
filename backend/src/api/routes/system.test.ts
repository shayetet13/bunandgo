import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { createSession, getSessionUser, SESSION_COOKIE } from "../../auth/session.ts";
import { createUser } from "../../auth/users.ts";
import { db } from "../../db/sqlite.ts";
import { refreshSquarePollQuietConfig } from "../../bot/square-poll-quiet.ts";
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
	db.prepare("DELETE FROM app_meta WHERE key = 'system.maintenance_mode'").run();
	db.prepare("DELETE FROM app_meta WHERE key = 'square.fast_poll.quiet_ms'").run();
	db.prepare("DELETE FROM lane_race_events").run();
	refreshSquarePollQuietConfig();
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

describe("/api/system/square-poll-quiet", () => {
	function quietRequest(app: Hono, cookie = "", quietMs?: unknown) {
		return app.request("/api/system/square-poll-quiet", {
			method: quietMs === undefined ? "GET" : "PUT",
			headers: {
				"content-type": "application/json",
				...(cookie ? { cookie } : {}),
			},
			...(quietMs === undefined ? {} : { body: JSON.stringify({ quietMs }) }),
		});
	}

	test("requires authentication and an admin role", async () => {
		const app = buildApp();
		expect((await quietRequest(app)).status).toBe(401);

		const user = createUser(`quiet-user-${Date.now()}`, "quiet-test-password");
		const userCookie = `${SESSION_COOKIE}=${createSession(user.id)}`;
		expect((await quietRequest(app, userCookie)).status).toBe(403);
	});

	test("GET defaults to 0, PUT rejects out-of-range and non-integer values", async () => {
		const app = buildApp();
		const adminCookie = `${SESSION_COOKIE}=${createSession()}`;
		expect(await (await quietRequest(app, adminCookie)).json()).toEqual({ quietMs: 0 });
		expect((await quietRequest(app, adminCookie, 99)).status).toBe(400);
		expect((await quietRequest(app, adminCookie, 12.5)).status).toBe(400);
	});

	test("PUT applies the window and GET reports it back", async () => {
		const app = buildApp();
		const adminCookie = `${SESSION_COOKIE}=${createSession()}`;
		const put = await quietRequest(app, adminCookie, 16);
		expect(put.status).toBe(200);
		expect(await put.json()).toEqual({ ok: true, quietMs: 16 });
		expect(await (await quietRequest(app, adminCookie)).json()).toEqual({ quietMs: 16 });
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
