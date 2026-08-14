import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { createSession, getSessionUser, SESSION_COOKIE } from "../../auth/session.ts";
import { createUser } from "../../auth/users.ts";
import { writeSessionCookie } from "./auth.ts";
import { createSystemRoute } from "./system.ts";

const tempDir = mkdtempSync(join(tmpdir(), "linebot-restart-route-"));
const triggerPath = join(tempDir, "restart.trigger");

async function requireAuth(c: Context, next: Next) {
	const token = getCookie(c, SESSION_COOKIE);
	if (!getSessionUser(token)) return c.json({ error: "unauthorized" }, 401);
	writeSessionCookie(c, token!);
	await next();
}

function buildApp(agentActive = true) {
	const app = new Hono();
	app.use("/api/system/*", requireAuth);
	app.route(
		"/api/system",
		createSystemRoute({
			triggerPath,
			isRestartAgentActive: async () => agentActive,
			isShardWorker: () => false,
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

afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

describe("POST /api/system/restart-worker", () => {
	test("requires authentication and an admin role", async () => {
		const app = buildApp();
		expect((await restartRequest(app)).status).toBe(401);

		const user = createUser(`restart-user-${Date.now()}`, "restart-test-password");
		const userCookie = `${SESSION_COOKIE}=${createSession(user.id)}`;
		expect((await restartRequest(app, userCookie)).status).toBe(403);
	});

	test("requires explicit confirmation and an active restart agent", async () => {
		const adminCookie = `${SESSION_COOKIE}=${createSession()}`;
		expect((await restartRequest(buildApp(), adminCookie, "wrong")).status).toBe(400);
		expect((await restartRequest(buildApp(false), adminCookie)).status).toBe(503);
	});

	test("writes one fixed trigger and enforces the persistent cooldown", async () => {
		const adminCookie = `${SESSION_COOKIE}=${createSession()}`;
		const app = buildApp();
		const response = await restartRequest(app, adminCookie);
		expect(response.status).toBe(202);
		const body = (await response.json()) as { ok: boolean; unit: string; requestedAt: number };
		expect(body.ok).toBe(true);
		expect(body.unit).toBe("linebot-worker.service");
		expect(readFileSync(triggerPath, "utf8")).toBe(`${body.requestedAt}\n`);

		const repeated = await restartRequest(app, adminCookie);
		expect(repeated.status).toBe(429);
		expect(Number(repeated.headers.get("retry-after"))).toBeGreaterThan(0);
	});
});
