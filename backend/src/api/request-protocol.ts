import type { Context } from "hono";

/**
 * Whether the request reached us over HTTPS, honoring a reverse proxy's
 * `X-Forwarded-Proto` ahead of what Bun's own listener saw.
 *
 * This server never terminates TLS itself (see `index.ts`/`api/server.ts`
 * — no cert config anywhere), so any real deployment puts a reverse proxy
 * in front that terminates TLS and forwards to this process over plain
 * HTTP. `c.req.url`'s protocol then always reads "http:" regardless of what
 * the browser actually used, which is exactly the case `bot-detail.ts`'s
 * `publicOrigin` already works around for building confirm-page links.
 * Without the same fix here, the session cookie's `Secure` attribute and
 * the `Strict-Transport-Security` header would silently never apply, even
 * once TLS is added in front — weakening the primary session-auth cookie
 * for the whole dashboard.
 */
export function isSecureRequest(c: Context): boolean {
	const forwardedProto = c.req.header("x-forwarded-proto");
	if (forwardedProto) return forwardedProto.split(",")[0]?.trim() === "https";
	return new URL(c.req.url).protocol === "https:";
}
