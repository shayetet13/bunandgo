import { Hono } from "hono";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { getCookie } from "hono/cookie";
import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { config } from "../config.ts";
import { botEvents, resumePreviouslyRunningBots } from "../bot/session-manager.ts";
import { recordAnomaly } from "../bot/anomalies.ts";
import { getSessionUser, SESSION_COOKIE } from "../auth/session.ts";
import { authRoute, writeSessionCookie } from "./routes/auth.ts";
import { canAccessBot, resequenceBotSlots } from "../bot/bots.ts";
import type { AuthUser } from "../auth/users.ts";
import { botsRoute } from "./routes/bots.ts";
import { botDetailRoute } from "./routes/bot-detail.ts";
import { metricsRoute } from "./routes/metrics.ts";
import { healthRoute } from "./routes/health.ts";
import { usersRoute } from "./routes/users.ts";
import { logsRoute } from "./routes/logs.ts";
import { confirmRoute } from "./routes/confirm.ts";
import { securityHeaders } from "./security-headers.ts";
import {
	routeBotOwner,
	routeConfirmationOwner,
	routeCurrentUserOwner,
	routeUserMutationOwner,
	requireControlPlaneForwardOnShard,
} from "./worker-proxy.ts";
import {
	eventBotId,
	FORWARDED_EVENTS,
	startWorkerEventRelay,
	type ForwardedEventName,
	workerEventsRoute,
} from "./worker-events.ts";

const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

const app = new Hono();
app.use(
	"*",
	cors({
		origin: (origin) => (origin && config.allowedOrigins.includes(origin) ? origin : undefined),
		credentials: true,
	}),
);
app.use("*", securityHeaders);

app.onError((err, c) => {
	if (err instanceof HTTPException) return err.getResponse();
	console.error("unhandled API error:", err);
	return c.json({ error: "internal server error" }, 500);
});

// A shard is an internal runtime endpoint, not a second public backend. This
// is a no-op for the standalone/control-plane process.
app.use("/api/*", requireControlPlaneForwardOnShard);
app.use("/ws", requireControlPlaneForwardOnShard);

app.route("/api/auth", authRoute);
// Loopback-only in deployment and authenticated independently with the
// shared control token. It must be mounted before browser auth middleware.
app.route("/internal/worker-events", workerEventsRoute);

async function requireAuth(c: Context, next: Next) {
	const token = getCookie(c, SESSION_COOKIE);
	if (!getSessionUser(token)) {
		return c.json({ error: "unauthorized" }, 401);
	}
	writeSessionCookie(c, token!);
	await next();
}

app.use("/ws", requireAuth);
app.use("/api/bots", requireAuth);
app.use("/api/bots/*", requireAuth);
app.use("/api/metrics/*", requireAuth);
app.use("/api/health", requireAuth);
app.use("/api/users", requireAuth);
app.use("/api/users/*", requireAuth);
app.use("/api/logs/*", requireAuth);

// Keep one public Nginx upstream (the control plane), then route every
// runtime-sensitive operation to the process that owns the bot/user.
app.use("/api/bots/:botId", routeBotOwner);
app.use("/api/bots/:botId/*", routeBotOwner);
app.use("/api/users/:id", routeUserMutationOwner);
app.use("/api/users/:id/*", routeUserMutationOwner);
app.use("/api/confirm/:token", routeConfirmationOwner);
app.use("/api/confirm/:token/*", routeConfirmationOwner);
app.use("/api/bots", async (c, next) => {
	if (c.req.method === "POST") return await routeCurrentUserOwner(c, next);
	await next();
});
app.use("/api/metrics/snapshot", routeCurrentUserOwner);
app.use("/api/metrics/fast-path", routeCurrentUserOwner);
app.use("/api/health", routeCurrentUserOwner);

app.route("/api/bots", botsRoute);
app.route("/api/bots/:botId", botDetailRoute);
app.route("/api/metrics", metricsRoute);
app.route("/api/health", healthRoute);
app.route("/api/users", usersRoute);
app.route("/api/logs", logsRoute);
// Deliberately outside requireAuth — see confirm.ts for why.
app.route("/api/confirm", confirmRoute);

function scopedEventData(user: AuthUser, type: ForwardedEventName, data: unknown): unknown {
	if (user.role === "admin") return data;
	const botId = eventBotId(data);
	if (botId === undefined || !canAccessBot(user, botId)) return undefined;
	if ((type === "send_result" || type === "fast_path") && data && typeof data === "object") {
		const last = (data as { last?: { latencyMs?: number; internalMs?: number; ok?: boolean } }).last;
		if (!last) return undefined;
		const value = type === "send_result" ? last.latencyMs ?? 0 : last.internalMs ?? 0;
		return type === "send_result"
			? { p50: value, p95: value, p99: value, okRate: last.ok === false ? 0 : 100, count: 1, windowSize: 1, last }
			: { p50: value, p95: value, p99: value, max: value, count: 1, last };
	}
	return data;
}

app.get(
	"/ws",
	upgradeWebSocket((c) => {
		const unsubscribers: Array<() => void> = [];
		const user = getSessionUser(getCookie(c, SESSION_COOKIE));
		return {
			onOpen(_event, ws) {
				if (!user) {
					ws.close(1008, "unauthorized");
					return;
				}
				for (const type of FORWARDED_EVENTS) {
					const listener = (data: unknown) => {
						const scoped = scopedEventData(user, type, data);
						if (scoped !== undefined) ws.send(JSON.stringify({ type, data: scoped ?? null }));
					};
					botEvents.on(type, listener);
					unsubscribers.push(() => botEvents.off(type, listener));
				}
			},
			onClose() {
				for (const unsubscribe of unsubscribers) unsubscribe();
				unsubscribers.length = 0;
			},
		};
	}),
);

const port = config.port;

export const server = Bun.serve({
	hostname: "0.0.0.0",
	port,
	fetch: app.fetch,
	websocket,
});

console.log(`api: listening on http://localhost:${port}`);

// No-op on the public control plane/standalone process. On a shard this
// forwards QR/status/reply events back to the one browser WebSocket endpoint.
startWorkerEventRelay();

// Repairs numbering left behind by the older allocator, which reused a
// deleted bot's slot instead of closing the gap. A no-op once the slots are
// already 1..N in creation order.
resequenceBotSlots();

// Deliberately after the listener is up and not awaited: resuming walks every
// bot with a stagger between them, and the dashboard should be reachable (and
// receiving the bot_status events this produces) throughout.
if (process.env.NODE_ENV !== "test") {
	void resumePreviouslyRunningBots().catch((err) => {
		// resumePreviouslyRunningBots already isolates per-bot failures with
		// its own try/catch, so reaching here means the whole mechanism broke
		// (not just one bot's session) — every bot that was running before
		// this restart is offline with nothing on the dashboard pointing at
		// why, so this needs more than a console line only server-log access
		// would ever see.
		console.error("resume after restart failed:", err);
		recordAnomaly({
			botId: null,
			kind: "resume_failed",
			severity: "critical",
			detail: `กู้คืนบอทหลัง backend รีสตาร์ททั้งระบบไม่สำเร็จ — ${err instanceof Error ? err.message : String(err)}`,
		});
	});
}
