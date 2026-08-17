import type { Context, Next } from "hono";
import { getBot } from "../bot/bots.ts";
import { getStartConfirmation } from "../bot/start-confirmation.ts";
import { inWorkerScope } from "../bot/worker-scope.ts";
import { readWorkerTopology, workerUrlForOwner } from "../bot/worker-topology.ts";
import { getUser } from "../auth/users.ts";
import { requestUser } from "../auth/request-user.ts";
import {
	CONTROL_TOKEN_HEADER,
	FORWARDED_HEADER,
	hasValidControlToken,
	isTrustedWorkerForward,
} from "./control-auth.ts";
import { reportSecurityIncident } from "../security/intrusion-monitor.ts";

export { CONTROL_TOKEN_HEADER, hasValidControlToken, isTrustedWorkerForward } from "./control-auth.ts";
const HOP_BY_HOP_HEADERS = [
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
];

function proxyError(c: Context, ownerUserId: number | null, status: 421 | 503, detail: string) {
	return c.json({
		error: status === 421 ? "request reached the wrong worker" : "owner worker unavailable",
		ownerUserId,
		detail,
	}, status);
}

export async function proxyRequestToWorker(c: Context, baseUrl: URL): Promise<Response> {
	const topology = readWorkerTopology();
	const source = new URL(c.req.url);
	// Assign path/query fields rather than resolving a string. A leading `//`
	// is a different host to URL resolution; it must never be able to turn a
	// loopback-only owner route into an outbound proxy.
	const target = new URL(baseUrl);
	target.pathname = source.pathname;
	target.search = source.search;
	const headers = new Headers(c.req.raw.headers);
	const originalHost = headers.get("host");
	headers.delete("host");
	headers.delete("content-length");
	for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
	headers.set(FORWARDED_HEADER, "1");
	headers.set(CONTROL_TOKEN_HEADER, topology.controlPlaneToken ?? "");
	headers.set("x-linebot-forwarded-by", topology.workerId);
	if (originalHost && !headers.has("x-forwarded-host")) headers.set("x-forwarded-host", originalHost);

	const method = c.req.method.toUpperCase();
	const body = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer();
	try {
		const response = await fetch(target, {
			method,
			headers,
			body,
			signal: AbortSignal.timeout(15_000),
		});
		const responseHeaders = new Headers(response.headers);
		for (const name of HOP_BY_HOP_HEADERS) responseHeaders.delete(name);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: responseHeaders,
		});
	} catch (error) {
		console.error(`worker proxy failed: ${target.origin}`, error instanceof Error ? error.message : error);
		return c.json({ error: "owner worker unavailable" }, 503);
	}
}

async function routeOwner(c: Context, next: Next, ownerUserId: number | null): Promise<Response | void> {
	if (inWorkerScope(ownerUserId)) return await next();
	if (isTrustedWorkerForward(c)) {
		return proxyError(c, ownerUserId, 421, "forwarded request does not belong to this worker");
	}
	const target = workerUrlForOwner(ownerUserId);
	if (!target) return proxyError(c, ownerUserId, 503, "no WORKER_OWNER_ROUTES entry exists");
	return await proxyRequestToWorker(c, target);
}

/** Routes the full /api/bots/:botId subtree so runtime caches mutate only on its owner worker. */
export async function routeBotOwner(c: Context, next: Next): Promise<Response | void> {
	const botId = Number(c.req.param("botId"));
	if (!Number.isInteger(botId) || botId <= 0) return await next();
	const bot = getBot(botId);
	return bot ? await routeOwner(c, next, bot.ownerUserId) : await next();
}

/** User deactivation/quota/delete can stop sessions, so those mutations follow the owner's bots. */
export async function routeUserMutationOwner(c: Context, next: Next): Promise<Response | void> {
	if (c.req.method !== "PATCH" && c.req.method !== "DELETE") return await next();
	const userId = Number(c.req.param("id"));
	if (!Number.isInteger(userId) || userId <= 0 || !getUser(userId)) return await next();
	return await routeOwner(c, next, userId);
}

/** The token is shared in SQLite; accepting/declining still executes on the bot's runtime worker. */
export async function routeConfirmationOwner(c: Context, next: Next): Promise<Response | void> {
	const confirmation = getStartConfirmation(c.req.param("token"));
	if (!confirmation) return await next();
	const bot = getBot(confirmation.botId);
	return bot ? await routeOwner(c, next, bot.ownerUserId) : await next();
}

/** POST /api/bots plus live metrics/health for a regular user belong to that user's runtime worker. */
export async function routeCurrentUserOwner(c: Context, next: Next): Promise<Response | void> {
	const user = requestUser(c);
	if (!user || user.role === "admin") return await next();
	return await routeOwner(c, next, user.id);
}

/**
 * Shard ports are runtime internals, never a second public API. Reject a
 * browser, accidental Nginx round-robin, or manual call that bypasses the
 * control plane even if it happens to carry a valid shared session cookie.
 */
export async function requireControlPlaneForwardOnShard(c: Context, next: Next): Promise<Response | void> {
	if (!readWorkerTopology().controlPlaneUrl || isTrustedWorkerForward(c)) return await next();
	reportSecurityIncident(c, { kind: "shard_bypass", severity: "critical" });
	return c.json({ error: "shard API accepts control-plane forwarded requests only" }, 421);
}
