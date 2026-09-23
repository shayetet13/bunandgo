import { Hono } from "hono";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { getCookie } from "hono/cookie";
import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { config } from "../config.ts";
import { botEvents, resumePreviouslyRunningBots, sweepLegacyIdLockNames } from "../bot/session-manager.ts";
import { recordAnomaly } from "../bot/anomalies.ts";
import { newlyAppliedMigrationIds } from "../db/sqlite.ts";
import { getSessionUser, SESSION_COOKIE } from "../auth/session.ts";
import { authRoute } from "./routes/auth.ts";
import { canAccessBot, resequenceBotSlots } from "../bot/bots.ts";
import type { AuthUser } from "../auth/users.ts";
import { botsRoute } from "./routes/bots.ts";
import { botDetailRoute } from "./routes/bot-detail.ts";
import { metricsRoute, allRecentLatency, latencySnapshot } from "./routes/metrics.ts";
import { healthRoute } from "./routes/health.ts";
import { usersRoute } from "./routes/users.ts";
import { logsRoute } from "./routes/logs.ts";
import { systemRoute } from "./routes/system.ts";
import { announcementsRoute } from "./routes/announcements.ts";
import { confirmRoute } from "./routes/confirm.ts";
import { securityHeaders } from "./security-headers.ts";
import { rejectCrossSiteWrite, rejectUntrustedWebSocketOrigin } from "./request-security.ts";
import { monitorPublicRequest, reportSecurityIncident } from "../security/intrusion-monitor.ts";
import { securityEvents } from "../security/security-events.ts";
import { eventBotId, FORWARDED_EVENTS, type ForwardedEventName } from "./forwarded-events.ts";
import { startServerLoadHistoryRecorder } from "../monitoring/server-load-history.ts";

const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

const app = new Hono();
app.use("*", monitorPublicRequest);
app.use(
	"*",
	cors({
		origin: (origin) => (origin && config.allowedOrigins.includes(origin) ? origin : undefined),
		credentials: true,
	}),
);
app.use("*", securityHeaders);
app.use("/api/*", rejectCrossSiteWrite);
app.use("/ws", rejectUntrustedWebSocketOrigin);

app.onError((err, c) => {
	if (err instanceof HTTPException) return err.getResponse();
	console.error("unhandled API error:", err);
	return c.json({ error: "internal server error" }, 500);
});

app.route("/api/auth", authRoute);
// Only Nginx can internally redirect to this path; public /internal requests
// are intercepted at the edge. It converts otherwise silent probes into a
// bounded audit event and out-of-band alert while keeping the public response
// indistinguishable from a normal rejection.
app.all("/internal/security-probe", (c) => {
	const reason = c.req.header("x-linebot-security-reason") ?? "scanner";
	const kind = reason === "oversized" ? "oversized_request" : reason === "method" ? "suspicious_method" : "scanner_probe";
	reportSecurityIncident(c, {
		kind,
		severity: reason === "oversized" ? "high" : "critical",
		path: c.req.header("x-linebot-original-path"),
		detail: `edge:${reason}`,
	});
	return c.json(
		{ error: reason === "oversized" ? "request too large" : reason === "method" ? "method not allowed" : "not found" },
		reason === "oversized" ? 413 : reason === "method" ? 405 : 404,
	);
});
async function requireAuth(c: Context, next: Next) {
	const token = getCookie(c, SESSION_COOKIE);
	if (!getSessionUser(token)) {
		reportSecurityIncident(c, { kind: "invalid_session", severity: "medium" });
		return c.json({ error: "unauthorized" }, 401);
	}
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
app.use("/api/system/*", requireAuth);
app.use("/api/announcements", requireAuth);
app.use("/api/announcements/*", requireAuth);

app.route("/api/bots", botsRoute);
app.route("/api/bots/:botId", botDetailRoute);
app.route("/api/metrics", metricsRoute);
app.route("/api/health", healthRoute);
app.route("/api/users", usersRoute);
app.route("/api/logs", logsRoute);
app.route("/api/system", systemRoute);
app.route("/api/announcements", announcementsRoute);
// Deliberately outside requireAuth — see confirm.ts for why.
app.route("/api/confirm", confirmRoute);

function scopedEventData(user: AuthUser, type: ForwardedEventName, data: unknown): unknown {
	if (user.role === "admin") return data;
	const botId = eventBotId(data);
	if (botId === undefined || !canAccessBot(user, botId)) return undefined;
	if ((type === "send_result" || type === "fast_path") && data && typeof data === "object") {
		const last = (data as { last?: { latencyMs?: number; internalMs?: number; ok?: boolean } }).last;
		if (!last) return undefined;
		const value = type === "send_result" ? (last.latencyMs ?? 0) : (last.internalMs ?? 0);
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
						// Recomputed over the same window /api/metrics/snapshot uses, so
						// the WS push and the page-load hydrate can never disagree (a
						// single fresh sample used to read as a clean 0%/100%).
						if (type === "send_result" && user.role === "admin") {
							ws.send(JSON.stringify({ type, data: latencySnapshot(allRecentLatency(500)) }));
							return;
						}
						const scoped = scopedEventData(user, type, data);
						if (scoped !== undefined) ws.send(JSON.stringify({ type, data: scoped ?? null }));
					};
					botEvents.on(type, listener);
					unsubscribers.push(() => botEvents.off(type, listener));
				}
				if (user.role === "admin") {
					const securityListener = (data: unknown) => ws.send(JSON.stringify({ type: "security_alert", data }));
					securityEvents.on("security_alert", securityListener);
					unsubscribers.push(() => securityEvents.off("security_alert", securityListener));
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
const hostname = "0.0.0.0";

export const server = Bun.serve({
	hostname,
	port,
	fetch: app.fetch,
	websocket,
});

console.log(`api: listening on http://${hostname}:${port}`);

// Repairs stable bot labels left by the older allocator and compacts the
// independently persisted card positions without undoing a user's drag.
resequenceBotSlots();

// Records both active machines' CPU/RAM history.
startServerLoadHistoryRecorder();

// Deliberately after the listener is up and not awaited: resuming walks every
// bot with a stagger between them, and the dashboard should be reachable (and
// receiving the bot_status events this produces) throughout.
if (process.env.NODE_ENV !== "test") {
	void (async () => {
		// Runs once, only in the boot that just applied this migration — see
		// runMigrations() in db/migrations.ts. Deliberately sequenced before
		// the resume below: it clears stored tokens for bots locked before
		// the display-name half of the id lock existed, and those bots must
		// not get a chance to silently resume on the now-about-to-be-cleared
		// token first.
		if (newlyAppliedMigrationIds.includes("028_bots_locked_line_display_name")) {
			try {
				await sweepLegacyIdLockNames();
			} catch (err) {
				// Isolated from the resume path below: a broken sweep must not
				// prevent bots it doesn't affect from resuming normally.
				console.error("legacy id-lock name sweep failed:", err);
			}
		}
		await resumePreviouslyRunningBots();
	})().catch((err) => {
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
