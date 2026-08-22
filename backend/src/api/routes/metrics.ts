import { Hono } from "hono";
import { latencyTracker, summarizeLatencyGuardrails } from "../../metrics/latency.ts";
import { db } from "../../db/sqlite.ts";
import type { LatencySampleRow } from "../../db/schema.ts";
import { fastPathTracker } from "../../metrics/fast-path.ts";
import { parseLimit } from "../limit.ts";
import { requestUser } from "../../auth/request-user.ts";
import { listBotIdsForUser } from "../../bot/bots.ts";
import type { LatencySample } from "../../metrics/latency.ts";
import type { FastPathSample } from "../../metrics/fast-path.ts";
import { laneRaceView, type LaneRaceLaneView } from "../../dispatch/h2-lanes.ts";
import { LANE_RACE_RETENTION_DAYS, laneRaceDailyHistory, laneRaceSnapshot, WORKER_ID } from "../../dispatch/lane-race.ts";
import { isControlPlane } from "../../bot/worker-topology.ts";
import { relayedFastPathSamples, relayedLatencySamples } from "../worker-events.ts";
import { remoteLaneRaces } from "../lane-relay-events.ts";

export const metricsRoute = new Hono();
const PROCESS_STARTED_AT = Date.now();

function percentile(values: number[], point: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * point) - 1)]!;
}

function latencySnapshot(samples: LatencySample[]) {
	const values = samples.map((sample) => sample.latencyMs);
	return {
		p50: percentile(values, 0.5),
		p95: percentile(values, 0.95),
		p99: percentile(values, 0.99),
		okRate: samples.length ? (samples.filter((sample) => sample.ok).length / samples.length) * 100 : 100,
		count: samples.length,
		windowSize: 500,
		last: samples.at(-1),
		guardrails: summarizeLatencyGuardrails(values),
	};
}

function fastSnapshot(samples: FastPathSample[]) {
	const completed = samples.filter((sample) => !sample.dropped);
	const values = completed.map((sample) => sample.internalMs);
	return {
		p50: percentile(values, 0.5),
		p95: percentile(values, 0.95),
		p99: percentile(values, 0.99),
		max: values.length ? Math.max(...values) : 0,
		count: completed.length,
		last: samples.at(-1),
	};
}

function visibleBotIds(c: Parameters<typeof requestUser>[0]): number[] | undefined {
	const user = requestUser(c)!;
	return user.role === "admin" ? undefined : listBotIdsForUser(user, { includeAllWorkers: isControlPlane() });
}

function allRecentLatency(limit: number): LatencySample[] {
	const samples = [...latencyTracker.recent(limit), ...(isControlPlane() ? relayedLatencySamples(limit) : [])];
	return samples.sort((a, b) => a.ts - b.ts).slice(-limit);
}

function allRecentFastPath(limit: number): FastPathSample[] {
	const samples = [...fastPathTracker.recent(limit), ...(isControlPlane() ? relayedFastPathSamples(limit) : [])];
	return samples.sort((a, b) => a.ts - b.ts).slice(-limit);
}

function latencyRowToSample(row: LatencySampleRow): LatencySample {
	const hasBreakdown = row.line_ms !== null;
	return {
		botId: row.bot_id!,
		ts: row.ts,
		surface: row.surface,
		targetMid: row.target_mid,
		latencyMs: row.latency_ms,
		ok: row.ok !== 0,
		source: row.source,
		textPreview: row.text_preview,
		lineCreatedTime: row.line_created_time ?? undefined,
		breakdown: hasBreakdown
			? {
					lineMs: row.line_ms ?? 0,
					codeMs: row.code_ms ?? 0,
					inboundMs: row.inbound_ms ?? undefined,
					decryptMs: row.decrypt_ms ?? 0,
					matchMs: row.match_ms ?? 0,
					limiterMs: row.limiter_ms ?? 0,
					routingMs: row.routing_ms ?? 0,
					protocolPrepMs: row.protocol_prep_ms ?? 0,
					relayEncodeMs: row.relay_encode_ms ?? 0,
					goPrepMs: row.go_prep_ms ?? 0,
					relayAndParseMs: row.relay_and_parse_ms ?? 0,
					upstreamCalls: row.upstream_calls ?? 0,
				}
			: undefined,
	};
}

metricsRoute.get("/snapshot", (c) => {
	const ids = visibleBotIds(c);
	const recent = allRecentLatency(500);
	if (ids === undefined) return c.json(latencySnapshot(recent));
	const allowed = new Set(ids);
	return c.json(latencySnapshot(recent.filter((sample) => allowed.has(sample.botId))));
});
metricsRoute.get("/fast-path", (c) => {
	const limit = parseLimit(c.req.query("limit"), 100, 1000);
	const ids = visibleBotIds(c);
	const allRecent = allRecentFastPath(1000);
	if (ids === undefined) {
		const recent = allRecent.slice(-limit);
		return c.json({ snapshot: fastSnapshot(allRecent), recent });
	}
	const allowed = new Set(ids);
	const recent = allRecent.filter((sample) => allowed.has(sample.botId)).slice(-limit);
	return c.json({ snapshot: fastSnapshot(recent), recent });
});

type LaneRaceResponseLane = LaneRaceLaneView & { workerId: string };

const recentLaneLatencyStmt = db.prepare<LatencySampleRow, [number]>(
	"SELECT * FROM latency_samples WHERE bot_id IS NOT NULL ORDER BY id DESC LIMIT ?",
);

/**
 * Observability only: sends are scored asynchronously after their response
 * has resolved. Persistence is write-behind, and this historical read runs
 * only when an admin refreshes the panel — never on the reply path.
 */
metricsRoute.get("/lane-race", (c) => {
	if (requestUser(c)!.role !== "admin") return c.json({ error: "forbidden" }, 403);
	// This process's own lanes plus whatever any lane-relay box (a separate
	// physical machine that owns no bots, only extra h2-lanes — see
	// backend/src/relay/) most recently reported. Tagged with workerId since
	// lane ids (0..15) repeat across processes/machines and would otherwise
	// collide as React keys on the dashboard.
	const lanes: LaneRaceResponseLane[] = [...laneRaceView().map((lane) => ({ ...lane, workerId: WORKER_ID })), ...remoteLaneRaces()];
	lanes.sort(
		(a, b) =>
			Number(b.routingPreferred) - Number(a.routingPreferred) ||
			(a.applicationRttMs ?? Number.POSITIVE_INFINITY) - (b.applicationRttMs ?? Number.POSITIVE_INFINITY) ||
			a.laneId - b.laneId ||
			a.workerId.localeCompare(b.workerId),
	);
	return c.json({
		retentionDays: LANE_RACE_RETENTION_DAYS,
		lanes,
		daily: laneRaceDailyHistory(),
		events: laneRaceSnapshot().events,
		// Uses the already-persisted write-behind latency rows. This query runs
		// only on the admin panel's 15-second refresh and touches no reply path.
		latency: recentLaneLatencyStmt.all(160).reverse().map(latencyRowToSample),
	});
});

function parseDateBound(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

metricsRoute.get("/history", (c) => {
	const limit = parseLimit(c.req.query("limit"), 200, 2000);
	const ids = visibleBotIds(c);
	if (ids?.length === 0) return c.json([]);
	const ownerFilter = ids ? ` AND bot_id IN (${ids.map(() => "?").join(",")})` : "";
	const from = parseDateBound(c.req.query("from"));
	const to = parseDateBound(c.req.query("to"));
	let rows: LatencySampleRow[];
	// Explicit date-range view (the admin logs page) reads newest-first, top
	// to bottom, like every other tab there — the trend chart that shares
	// this endpoint via the other two branches needs the opposite
	// (oldest-first, so it plots left-to-right), so only those get reversed.
	if (from !== undefined || to !== undefined) {
		rows = db
			.query<LatencySampleRow, number[]>(`SELECT * FROM latency_samples WHERE ts >= ? AND ts <= ?${ownerFilter} ORDER BY id DESC LIMIT ?`)
			.all(from ?? 0, to ?? Date.now(), ...(ids ?? []), limit);
	} else if (c.req.query("scope") === "all") {
		rows = db
			.query<LatencySampleRow, number[]>(`SELECT * FROM latency_samples WHERE 1=1${ownerFilter} ORDER BY id DESC LIMIT ?`)
			.all(...(ids ?? []), limit);
		rows.reverse();
	} else {
		rows = db
			.query<LatencySampleRow, number[]>(`SELECT * FROM latency_samples WHERE ts >= ?${ownerFilter} ORDER BY id DESC LIMIT ?`)
			.all(PROCESS_STARTED_AT, ...(ids ?? []), limit);
		rows.reverse();
	}
	return c.json(rows.filter((row) => row.bot_id !== null).map(latencyRowToSample));
});

interface BucketCount {
	bucket: string;
	count: number;
}

const countSinceStmt = db.prepare<{ count: number }, [number]>("SELECT COUNT(*) as count FROM latency_samples WHERE ts >= ?");
const countAllStmt = db.prepare<{ count: number }, []>("SELECT COUNT(*) as count FROM latency_samples");
const dailyStmt = db.prepare<BucketCount, [number]>(
	"SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') as bucket, COUNT(*) as count FROM latency_samples WHERE ts >= ? GROUP BY bucket ORDER BY bucket ASC",
);
const monthlyStmt = db.prepare<BucketCount, [number]>(
	"SELECT strftime('%Y-%m', ts/1000, 'unixepoch', 'localtime') as bucket, COUNT(*) as count FROM latency_samples WHERE ts >= ? GROUP BY bucket ORDER BY bucket ASC",
);
const yearlyStmt = db.prepare<BucketCount, []>(
	"SELECT strftime('%Y', ts/1000, 'unixepoch', 'localtime') as bucket, COUNT(*) as count FROM latency_samples GROUP BY bucket ORDER BY bucket ASC",
);

// Real counts from the full (unbounded) latency_samples history — not the
// in-memory ring buffer, which only keeps the last 500 for P95 — so
// day/month/year totals reflect everything ever sent, not a recent slice.
metricsRoute.get("/summary", (c) => {
	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
	const startOfYear = new Date(now.getFullYear(), 0, 1).getTime();
	const start30Days = startOfToday - 29 * 86_400_000;
	const start12Months = new Date(now.getFullYear(), now.getMonth() - 11, 1).getTime();

	const ids = visibleBotIds(c);
	if (ids === undefined) {
		return c.json({
			totalMessages: countAllStmt.get()?.count ?? 0,
			todayCount: countSinceStmt.get(startOfToday)?.count ?? 0,
			monthCount: countSinceStmt.get(startOfMonth)?.count ?? 0,
			yearCount: countSinceStmt.get(startOfYear)?.count ?? 0,
			daily: dailyStmt.all(start30Days),
			monthly: monthlyStmt.all(start12Months),
			yearly: yearlyStmt.all(),
		});
	}
	if (ids.length === 0) return c.json({ totalMessages: 0, todayCount: 0, monthCount: 0, yearCount: 0, daily: [], monthly: [], yearly: [] });
	const placeholders = ids.map(() => "?").join(",");
	const count = (since?: number) =>
		db
			.query<{ count: number }, number[]>(
				`SELECT COUNT(*) AS count FROM latency_samples WHERE bot_id IN (${placeholders})${since === undefined ? "" : " AND ts >= ?"}`,
			)
			.get(...ids, ...(since === undefined ? [] : [since]))?.count ?? 0;
	const buckets = (format: string, since?: number) =>
		db
			.query<BucketCount, number[]>(
				`SELECT strftime('${format}', ts/1000, 'unixepoch', 'localtime') AS bucket, COUNT(*) AS count FROM latency_samples WHERE bot_id IN (${placeholders})${since === undefined ? "" : " AND ts >= ?"} GROUP BY bucket ORDER BY bucket ASC`,
			)
			.all(...ids, ...(since === undefined ? [] : [since]));
	return c.json({
		totalMessages: count(),
		todayCount: count(startOfToday),
		monthCount: count(startOfMonth),
		yearCount: count(startOfYear),
		daily: buckets("%Y-%m-%d", start30Days),
		monthly: buckets("%Y-%m", start12Months),
		yearly: buckets("%Y"),
	});
});
