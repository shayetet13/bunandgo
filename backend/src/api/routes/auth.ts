import { Hono } from "hono";
import { z } from "zod";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getConnInfo } from "hono/bun";
import {
	authenticate,
	createSession,
	destroySession,
	getSessionUser,
	SESSION_COOKIE,
	SESSION_MAX_AGE_SECONDS,
} from "../../auth/session.ts";
import { BOT_PRICE_THB_PER_MONTH, MAX_BOT_QUOTA } from "../../auth/users.ts";
import { clearLoginAttempts, tryAcquireLoginAttempt } from "../../auth/login-throttle.ts";
import { logUnauthenticatedUserAction, logUserAction } from "../../auth/user-actions.ts";
import { isSecureRequest } from "../request-protocol.ts";

export const authRoute = new Hono();

function writeSessionCookie(c: Parameters<typeof setCookie>[0], token: string): void {
	setCookie(c, SESSION_COOKIE, token, {
		httpOnly: true,
		sameSite: "Lax",
		path: "/",
		// Chromium caps persistent cookies at 400 days. `/me` and authenticated
		// API calls renew this window, so an actively used login remains alive
		// until explicit Logout.
		maxAge: SESSION_MAX_AGE_SECONDS,
		secure: isSecureRequest(c),
	});
}

const loginBodySchema = z.object({
	username: z.string().min(1),
	password: z.string().min(1),
});

function remoteAddress(c: Parameters<typeof getConnInfo>[0]): string {
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
	const ip = remoteAddress(c);
	const throttleKey = `${ip}|${rawUsername.toLowerCase()}`;

	// Throttle before validating so a flood of malformed bodies can't dodge the limiter.
	const admission = tryAcquireLoginAttempt(throttleKey);
	if (!admission.allowed) {
		logUnauthenticatedUserAction(rawUsername, "auth.login.throttled", { ip });
		c.header("Retry-After", String(Math.ceil(admission.retryAfterMs / 1000)));
		return c.json({ ok: false, error: "พยายามเข้าสู่ระบบบ่อยเกินไป กรุณาลองใหม่ภายหลัง" }, 429);
	}

	const result = loginBodySchema.safeParse(rawBody);
	if (!result.success) {
		logUnauthenticatedUserAction(rawUsername, "auth.login.failed", { ip, reason: "invalid_request" });
		return c.json({ ok: false, error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" }, 400);
	}

	const user = authenticate(result.data.username, result.data.password);
	if (!user) {
		logUnauthenticatedUserAction(result.data.username, "auth.login.failed", { ip, reason: "invalid_credentials" });
		return c.json({ ok: false, error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" }, 401);
	}
	clearLoginAttempts(throttleKey);
	const token = createSession(user.id);
	writeSessionCookie(c, token);
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

authRoute.get("/me", (c) => {
	const token = getCookie(c, SESSION_COOKIE);
	const user = getSessionUser(token);
	if (user && token) writeSessionCookie(c, token);
	return c.json({
		authenticated: !!user,
		username: user?.username ?? null,
		role: user?.role ?? null,
		// The console needs both to tell someone they are out of bots and
		// what another one costs, without a second round trip.
		botQuota: user?.botQuota ?? null,
		maxBotQuota: MAX_BOT_QUOTA,
		botPricePerMonthThb: BOT_PRICE_THB_PER_MONTH,
	});
});

export { writeSessionCookie };
