import type { Context, Next } from "hono";
import { config } from "../config.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * A missing Origin is treated as trusted here on purpose, not by oversight:
 * a real browser always sends Origin on both a WebSocket handshake (mandated
 * by the WebSocket protocol itself, unlike a plain fetch) and any same- or
 * cross-site state-changing request — the CSRF/hostile-page threat model
 * this guard exists for. A request with no Origin at all is a non-browser
 * caller (curl, a server-to-server hop, a CLI tool), which this check was
 * never meant to gate. The actual load-bearing defense against a browser
 * CSRF is the session cookie's `sameSite: "Strict"` (see api/routes/auth.ts) —
 * this Origin check, and rejectCrossSiteWrite's `sec-fetch-site` check
 * alongside it, are additional layers on top of that, not the only one. If
 * `sameSite` is ever loosened, revisit this assumption.
 */
function trustedBrowserOrigin(c: Context): boolean {
	const origin = c.req.header("origin");
	if (!origin || config.allowedOrigins.includes(origin)) return true;
	try {
		const parsed = new URL(origin);
		const forwardedProtocol = c.req.header("x-forwarded-proto")?.split(",", 1)[0]?.trim();
		const expectedProtocol = forwardedProtocol ? `${forwardedProtocol}:` : new URL(c.req.url).protocol;
		return parsed.host === c.req.header("host") && parsed.protocol === expectedProtocol;
	} catch {
		return false;
	}
}

/** Blocks browser cross-site writes while preserving CLI/internal callers. */
export async function rejectCrossSiteWrite(c: Context, next: Next) {
	if (SAFE_METHODS.has(c.req.method)) return await next();
	if (c.req.header("sec-fetch-site") === "cross-site" || !trustedBrowserOrigin(c)) {
		return c.json({ error: "cross-site request rejected" }, 403);
	}
	await next();
}

/** A hostile page must not be able to open an authenticated dashboard socket. */
export async function rejectUntrustedWebSocketOrigin(c: Context, next: Next) {
	if (!trustedBrowserOrigin(c)) return c.json({ error: "untrusted websocket origin" }, 403);
	await next();
}
