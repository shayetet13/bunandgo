import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { SESSION_COOKIE, createSession, destroySession } from "../../auth/session.ts";
import { createUser, deleteUserRecord } from "../../auth/users.ts";
import { healthRoute } from "./health.ts";

describe("health diagnostics authorization", () => {
	test("does not expose infrastructure diagnostics to a regular user", async () => {
		const user = createUser(`health-user-${Date.now()}`, "health-secure-password");
		const token = createSession(user.id);
		try {
			const app = new Hono();
			app.route("/api/health", healthRoute);
			const response = await app.request("/api/health", {
				headers: { cookie: `${SESSION_COOKIE}=${token}` },
			});
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ error: "admin only" });
		} finally {
			destroySession(token);
			deleteUserRecord(user.id);
		}
	});
});
