import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { getSessionUser, SESSION_COOKIE } from "./session.ts";

export function requestUser(c: Context) {
	return getSessionUser(getCookie(c, SESSION_COOKIE));
}

/** Route-wide guard for admin-only routers — mount with `router.use("*", requireAdmin)`. */
export async function requireAdmin(c: Context, next: Next) {
	if (requestUser(c)?.role !== "admin") return c.json({ error: "admin only" }, 403);
	await next();
}
