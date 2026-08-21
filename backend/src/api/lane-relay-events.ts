import { Hono } from "hono";
import { z } from "zod";
import { safeTokenEqual } from "./worker-proxy.ts";
import { formatZodError } from "./validate.ts";
import type { LaneStat } from "../dispatch/h2-lanes.ts";
import type { LaneRaceLaneView } from "../dispatch/h2-lanes.ts";
import { updateRemoteLaneFromReport } from "../dispatch/remote-lane.ts";

export const LANE_RELAY_TOKEN_HEADER = "x-lane-relay-token";

/**
 * A lane relay (see `backend/src/relay/`) is a separate physical box that
 * owns zero LINE sessions/bots — it only executes dispatch on this process's
 * behalf and reports its own h2-lanes back here for the dashboard. Its token
 * is deliberately its own secret, not `CONTROL_PLANE_TOKEN`: that token can
 * forward arbitrary API requests to a bot-owning worker (see worker-proxy.ts)
 * and a relay box has no business holding a credential that powerful.
 */
// Read fresh on every call, not cached at module load — matches
// readWorkerTopology()'s convention so tests can set/change the env var
// without fighting Bun's module cache.
function laneRelayToken(): string | undefined {
	return process.env.LANE_RELAY_TOKEN?.trim() || undefined;
}

/** Two report intervals' worth of grace before a relay is treated as gone,
 * so one missed push (a GC pause, a blip on the tunnel) doesn't blank it. */
const REPORT_STALE_MS = Math.max(5_000, Number(process.env.LANE_RELAY_STALE_MS ?? 15_000));

/** Defensive bound only — the token already keeps this to trusted senders.
 * Exported so the test can hit the limit without hardcoding the number. */
export const MAX_TRACKED_WORKERS = 16;

const laneScoreSchema = z.object({
	samples: z.number(),
	stars: z.number(),
	bananas: z.number(),
	bigStars: z.number(),
	avgRttMs: z.number().optional(),
	lastAt: z.number().optional(),
	lastResult: z.enum(["star", "banana"]).optional(),
});

const laneStatSchema = z.object({
	origin: z.string().min(1).max(200),
	id: z.number().int(),
	state: z.enum(["connecting", "ready", "draining", "dead"]),
	inFlight: z.number().int(),
	lastOkAt: z.number(),
	rttMs: z.number().optional(),
	sendRttMs: z.number().optional(),
	pollRttMs: z.number().optional(),
	lastSendOkAt: z.number(),
	lastPollOkAt: z.number(),
	applicationRttMs: z.number().optional(),
	applicationSampleAt: z.number(),
	routingEligible: z.boolean(),
	consecutiveFailures: z.number().int(),
	openedAt: z.number(),
});

const laneRaceViewSchema = z.object({
	origin: z.string().min(1).max(200),
	laneId: z.number().int(),
	state: z.string(),
	inFlight: z.number().int(),
	sendRttMs: z.number().optional(),
	pollRttMs: z.number().optional(),
	applicationRttMs: z.number().optional(),
	applicationSampleAt: z.number(),
	routingEligible: z.boolean(),
	send: laneScoreSchema,
	poll: laneScoreSchema,
});

const reportSchema = z.object({
	workerId: z.string().min(1).max(64),
	ts: z.number(),
	lanes: z.array(laneStatSchema).max(64),
	races: z.array(laneRaceViewSchema).max(64),
});

interface StoredReport {
	workerId: string;
	receivedAt: number;
	lanes: LaneStat[];
	races: LaneRaceLaneView[];
}

const reports = new Map<string, StoredReport>();

export const laneRelayEventsRoute = new Hono();

laneRelayEventsRoute.post("/", async (c) => {
	const token = laneRelayToken();
	if (!token) return c.json({ error: "lane relay reporting is not configured" }, 503);
	if (!safeTokenEqual(c.req.header(LANE_RELAY_TOKEN_HEADER), token)) {
		return c.json({ error: "forbidden" }, 403);
	}
	const body = await c.req.json().catch(() => undefined);
	const result = reportSchema.safeParse(body);
	if (!result.success) return c.json({ error: formatZodError(result.error) }, 400);

	const { workerId, lanes, races } = result.data;
	if (!reports.has(workerId) && reports.size >= MAX_TRACKED_WORKERS) {
		return c.json({ error: "too many distinct lane relay workers reporting" }, 429);
	}
	const receivedAt = Date.now();
	reports.set(workerId, { workerId, receivedAt, lanes: lanes as LaneStat[], races: races as LaneRaceLaneView[] });

	// Keeps the routing candidate in remote-lane.ts warm from the relay's own
	// self-report, so laneFetch() has a background RTT estimate to race
	// against even before this process has dispatched anything through it —
	// see remote-lane.ts's own docs for why this never adds a network round
	// trip to a live send/poll decision.
	const bestByOrigin = new Map<string, number>();
	for (const lane of lanes as LaneStat[]) {
		if (lane.state !== "ready" || lane.applicationRttMs === undefined) continue;
		const best = bestByOrigin.get(lane.origin);
		if (best === undefined || lane.applicationRttMs < best) bestByOrigin.set(lane.origin, lane.applicationRttMs);
	}
	for (const [origin, bestRttMs] of bestByOrigin) updateRemoteLaneFromReport(origin, bestRttMs, receivedAt);

	return c.json({ accepted: true }, 202);
});

/** Dashboard-only merge input: every lane relay's most recent report, tagged
 * with the workerId it came from, dropped once it goes stale. */
export function remoteLaneStats(maxAgeMs = REPORT_STALE_MS): Array<LaneStat & { workerId: string }> {
	const now = Date.now();
	const out: Array<LaneStat & { workerId: string }> = [];
	for (const report of reports.values()) {
		if (now - report.receivedAt > maxAgeMs) continue;
		for (const lane of report.lanes) out.push({ ...lane, workerId: report.workerId });
	}
	return out;
}

export function remoteLaneRaces(maxAgeMs = REPORT_STALE_MS): Array<LaneRaceLaneView & { workerId: string }> {
	const now = Date.now();
	const out: Array<LaneRaceLaneView & { workerId: string }> = [];
	for (const report of reports.values()) {
		if (now - report.receivedAt > maxAgeMs) continue;
		for (const race of report.races) out.push({ ...race, workerId: report.workerId });
	}
	return out;
}

/** Test-only reset so cases don't leak reports into each other. */
export function resetLaneRelayReportsForTest(): void {
	reports.clear();
}
