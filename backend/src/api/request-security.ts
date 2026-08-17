import type { Context, Next } from "hono";
import { config } from "../config.ts";
import { isTrustedWorkerForward } from "./worker-proxy.ts";
import { reportSecurityIncident } from "../security/intrusion-monitor.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

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
	// A request the control plane already verified and forwarded to this
	// shard (see worker-proxy.ts's proxyRequestToWorker) carries the
	// original browser's Origin untouched but a rewritten Host — it's a
	// server-to-server hop authenticated by the shared control token, not a
	// browser navigation, so the same-origin check below does not apply to
	// it at all and would otherwise reject every owner-scoped write for
	// whichever owner happens to live on a shard.
	if (isTrustedWorkerForward(c)) return await next();
	if (c.req.header("sec-fetch-site") === "cross-site" || !trustedBrowserOrigin(c)) {
		reportSecurityIncident(c, { kind: "cross_site_write", severity: "critical" });
		return c.json({ error: "cross-site request rejected" }, 403);
	}
	await next();
}

/** A hostile page must not be able to open an authenticated dashboard socket. */
export async function rejectUntrustedWebSocketOrigin(c: Context, next: Next) {
	if (!trustedBrowserOrigin(c)) {
		reportSecurityIncident(c, { kind: "untrusted_websocket", severity: "critical" });
		return c.json({ error: "untrusted websocket origin" }, 403);
	}
	await next();
}
