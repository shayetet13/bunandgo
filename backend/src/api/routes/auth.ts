import { Hono } from "hono";
import { z } from "zod";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getConnInfo } from "hono/bun";
import { authenticate, createSession, destroySession, getSessionUser, SESSION_COOKIE, sessionMaxAgeSeconds } from "../../auth/session.ts";
import type { AuthUser } from "../../auth/users.ts";
import { BOT_PRICE_THB_PER_MONTH, changePassword, MAX_BOT_QUOTA, UserValidationError } from "../../auth/users.ts";
import { clearLoginAttempts, tryAcquireLoginAttempt } from "../../auth/login-throttle.ts";
import { logUnauthenticatedUserAction, logUserAction } from "../../auth/user-actions.ts";
import { isMaintenanceModeEnabled } from "../../bot/maintenance-mode.ts";
import { isSecureRequest } from "../request-protocol.ts";

export const authRoute = new Hono();

function writeSessionCookie(c: Parameters<typeof setCookie>[0], token: string, user: AuthUser): void {
	setCookie(c, SESSION_COOKIE, token, {
		httpOnly: true,
		sameSite: "Strict",
		path: "/",
		maxAge: sessionMaxAgeSeconds(user.role),
		secure: isSecureRequest(c),
	});
}

const loginBodySchema = z.object({
	username: z.string().min(1).max(50),
	password: z.string().min(1).max(200),
});

function remoteAddress(c: Parameters<typeof getConnInfo>[0]): string {
	// Server 2 accepts API traffic only from our Nginx gateway, which replaces
	// this header. It therefore identifies the browser more accurately than
	// the WireGuard peer address seen by Bun.
	const forwarded = c.req.header("x-real-ip")?.trim();
	if (forwarded && forwarded.length <= 64 && /^[0-9a-f:.]+$/i.test(forwarded)) return forwarded;
	// getConnInfo needs a real Bun.serve request context; falls back to a
	// shared bucket (still throttled, just not per-IP) under Hono's in-memory
	// `app.request()` test harness or any other adapter that doesn't provide it.
	try {
		return getConnInfo(c).remote.address ?? "unknown";
	} catch {
		return "unknown";
	}
}

authRoute.post("/login", async (c) => {
	const rawBody = await c.req.json().catch(() => ({}));
	const rawUsername = typeof (rawBody as { username?: unknown })?.username === "string" ? (rawBody as { username: string }).username : "";
	const auditUsername = rawUsername.slice(0, 100);
	const ip = remoteAddress(c);
	const throttleKey = `${ip}|${rawUsername.slice(0, 64).toLowerCase()}`;

	// Throttle before validating so a flood of malformed bodies can't dodge the limiter.
	const admission = tryAcquireLoginAttempt(throttleKey);
	if (!admission.allowed) {
		logUnauthenticatedUserAction(auditUsername, "auth.login.throttled", { ip });
		c.header("Retry-After", String(Math.ceil(admission.retryAfterMs / 1000)));
		return c.json({ ok: false, error: "พยายามเข้าสู่ระบบบ่อยเกินไป กรุณาลองใหม่ภายหลัง" }, 429);
	}

	const result = loginBodySchema.safeParse(rawBody);
	if (!result.success) {
		logUnauthenticatedUserAction(auditUsername, "auth.login.failed", { ip, reason: "invalid_request" });
		return c.json({ ok: false, error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" }, 400);
	}

	const user = authenticate(result.data.username, result.data.password);
	if (!user) {
		logUnauthenticatedUserAction(result.data.username, "auth.login.failed", { ip, reason: "invalid_credentials" });
		return c.json({ ok: false, error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" }, 401);
	}
	clearLoginAttempts(throttleKey);
	const token = createSession(user.id);
	writeSessionCookie(c, token, user);
	logUserAction(user, "auth.login.success", { ip });
	return c.json({ ok: true, user: { username: user.username, role: user.role } });
});

authRoute.post("/logout", (c) => {
	const token = getCookie(c, SESSION_COOKIE);
	const user = getSessionUser(token);
	destroySession(token);
	deleteCookie(c, SESSION_COOKIE, { path: "/" });
	if (user) logUserAction(user, "logout");
	return c.json({ ok: true });
});

const changePasswordBodySchema = z.object({
	currentPassword: z.string().min(1).max(200),
	newPassword: z.string().min(12).max(200),
});

authRoute.post("/change-password", async (c) => {
	const token = getCookie(c, SESSION_COOKIE);
	const user = getSessionUser(token);
	if (!user) return c.json({ error: "unauthorized" }, 401);
	const throttleKey = `password-change|${remoteAddress(c)}|${user.id}`;
	const admission = tryAcquireLoginAttempt(throttleKey);
	if (!admission.allowed) {
		c.header("Retry-After", String(Math.ceil(admission.retryAfterMs / 1000)));
		return c.json({ error: "พยายามเปลี่ยนรหัสผ่านบ่อยเกินไป กรุณาลองใหม่ภายหลัง" }, 429);
	}
	const result = changePasswordBodySchema.safeParse(await c.req.json().catch(() => undefined));
	if (!result.success) return c.json({ error: "รหัสผ่านใหม่ต้องยาวอย่างน้อย 12 ตัวอักษร" }, 400);
	try {
		if (!changePassword(user.id, result.data.currentPassword, result.data.newPassword)) {
			logUserAction(user, "auth.password.change.failed", { reason: "invalid_current_password" });
			return c.json({ error: "รหัสผ่านปัจจุบันไม่ถูกต้อง" }, 400);
		}
		const newToken = createSession(user.id);
		clearLoginAttempts(throttleKey);
		writeSessionCookie(c, newToken, user);
		logUserAction(user, "auth.password.changed");
		return c.json({ ok: true });
	} catch (error) {
		if (error instanceof UserValidationError) return c.json({ error: error.message }, 400);
		throw error;
	}
});

authRoute.get("/me", (c) => {
	const token = getCookie(c, SESSION_COOKIE);
	const user = getSessionUser(token);
	return c.json({
		authenticated: !!user,
		username: user?.username ?? null,
		role: user?.role ?? null,
		// The console needs both to tell someone they are out of bots and
		// what another one costs, without a second round trip.
		botQuota: user?.botQuota ?? null,
		maxBotQuota: MAX_BOT_QUOTA,
		botPricePerMonthThb: BOT_PRICE_THB_PER_MONTH,
		// Only the "user"-role console reacts to this — the bot and the admin
		// dashboard both ignore it. See bot/maintenance-mode.ts.
		maintenanceMode: isMaintenanceModeEnabled(),
	});
});
