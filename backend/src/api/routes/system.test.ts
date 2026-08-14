import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { createSession, getSessionUser, SESSION_COOKIE } from "../../auth/session.ts";
import { createUser } from "../../auth/users.ts";
import { db } from "../../db/sqlite.ts";
import { writeSessionCookie } from "./auth.ts";
import { createSystemRoute } from "./system.ts";

async function requireAuth(c: Context, next: Next) {
	const token = getCookie(c, SESSION_COOKIE);
	if (!getSessionUser(token)) return c.json({ error: "unauthorized" }, 401);
	writeSessionCookie(c, token!);
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

beforeEach(() => db.prepare("DELETE FROM app_meta WHERE key = 'system.worker.last_restart_requested_at'").run());

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
