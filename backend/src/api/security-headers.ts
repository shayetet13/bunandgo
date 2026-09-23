import type { Context, Next } from "hono";
import { isSecureRequest } from "./request-protocol.ts";

/**
 * Baseline response headers for an API server that never renders HTML itself
 * — mainly guards against the dashboard being framed/sniffed if it's ever
 * proxied alongside other content. HSTS only makes sense once TLS is
 * actually terminated somewhere in front of this request.
 */
export async function securityHeaders(c: Context, next: Next): Promise<void> {
	await next();
	c.header("X-Content-Type-Options", "nosniff");
	c.header("X-Frame-Options", "DENY");
	c.header("Referrer-Policy", "no-referrer");
	c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
	if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/internal/") || c.req.path === "/ws") {
		c.header("Cache-Control", "no-store");
		c.header("Pragma", "no-cache");
	}
	if (isSecureRequest(c)) {
		c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
	}
}
