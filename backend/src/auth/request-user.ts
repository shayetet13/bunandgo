import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { getSessionUser, SESSION_COOKIE } from "./session.ts";
import { reportSecurityIncident } from "../security/intrusion-monitor.ts";

export function requestUser(c: Context) {
	return getSessionUser(getCookie(c, SESSION_COOKIE));
}

/** Route-wide guard for admin-only routers — mount with `router.use("*", requireAdmin)`. */
export async function requireAdmin(c: Context, next: Next) {
	const user = requestUser(c);
	if (user?.role !== "admin") {
		reportSecurityIncident(c, {
			kind: "forbidden_access",
			severity: "high",
			username: user?.username,
			detail: "admin role required",
		});
		return c.json({ error: "admin only" }, 403);
	}
	await next();
}
