import { Hono } from "hono";
import { db } from "../../db/sqlite.ts";
import type { AnomalySeverity, UserActionRow } from "../../db/schema.ts";
import { requireAdmin } from "../../auth/request-user.ts";
import { parseLimit } from "../limit.ts";
import { listAnomalies, summarizeAnomalies } from "../../bot/anomalies.ts";

export const logsRoute = new Hono();

// An audit trail across every user is inherently admin-only — a regular
// user's own actions on their own bots are already visible in that bot's
// /events history without needing this route at all.
logsRoute.use("*", requireAdmin);

function parseDateBound(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

const userActionsStmt = db.prepare<UserActionRow, [number, number, number]>(
	"SELECT * FROM user_actions WHERE ts >= ? AND ts <= ? ORDER BY id DESC LIMIT ?",
);

logsRoute.get("/user-actions", (c) => {
	const limit = parseLimit(c.req.query("limit"), 200, 2000);
	const from = parseDateBound(c.req.query("from")) ?? 0;
	const to = parseDateBound(c.req.query("to")) ?? Date.now();
	// Newest first, top to bottom — matches every other tab on the admin
	// logs page. The DESC query above already returns that order.
	return c.json(userActionsStmt.all(from, to, limit));
});

function parseBotId(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isInteger(value) ? value : undefined;
}

function parseSeverity(raw: string | undefined): AnomalySeverity | undefined {
	return raw === "info" || raw === "warn" || raw === "critical" ? raw : undefined;
}

/**
 * Everything that got between a trigger and its reply — deletions,
 * accepted-but-invisible sends, our own throttle, dead listeners. Newest
 * first, filterable by bot/kind/severity/time.
 */
logsRoute.get("/anomalies", (c) => {
	const since = parseDateBound(c.req.query("since"));
	return c.json(
		listAnomalies({
			botId: parseBotId(c.req.query("botId")),
			kind: c.req.query("kind") || undefined,
			severity: parseSeverity(c.req.query("severity")),
			since,
			limit: parseLimit(c.req.query("limit"), 200, 500),
		}),
	);
});

/** Per-kind counts for the tab's summary strip. Defaults to the last 24h. */
logsRoute.get("/anomalies/summary", (c) => {
	const windowMs = parseLimit(c.req.query("windowHours"), 24, 720) * 60 * 60_000;
	return c.json(summarizeAnomalies(Date.now() - windowMs, parseBotId(c.req.query("botId"))));
});
