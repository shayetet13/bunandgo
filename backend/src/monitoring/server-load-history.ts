import { db } from "../db/sqlite.ts";
import type { MonitoredServerId, ServerLoadSampleRow } from "../db/schema.ts";
import { getSystemLoadSnapshot } from "./system-load.ts";
import { shouldRunControlPlaneJobs } from "../bot/worker-topology.ts";
import { latestRemoteServerLoad } from "../api/lane-relay-events.ts";

export interface ServerLoad {
	cpuPercent: number;
	memoryPercent: number;
	capacityPercent: number;
	exceeded: boolean;
	sampledAt: number;
}

export interface ServerLoadSample {
	serverId: MonitoredServerId;
	ts: number;
	cpuPercent: number;
	memoryPercent: number;
	capacityPercent: number;
	eventLoopLagMs: number | null;
}

function fromRow(row: ServerLoadSampleRow): ServerLoadSample {
	return {
		serverId: row.server_id,
		ts: row.ts,
		cpuPercent: row.cpu_percent,
		memoryPercent: row.memory_percent,
		capacityPercent: row.capacity_percent,
		eventLoopLagMs: row.event_loop_lag_ms,
	};
}

const insertStmt = db.prepare<null, [MonitoredServerId, number, number, number, number, number | null]>(
	"INSERT INTO server_load_samples (server_id, ts, cpu_percent, memory_percent, capacity_percent, event_loop_lag_ms) VALUES (?, ?, ?, ?, ?, ?)",
);
const listSinceStmt = db.prepare<ServerLoadSampleRow, [number]>("SELECT * FROM server_load_samples WHERE ts >= ? ORDER BY ts ASC");
const pruneStmt = db.prepare<null, [number]>("DELETE FROM server_load_samples WHERE ts < ?");

export function recordServerLoadSample(
	serverId: MonitoredServerId,
	load: { cpuPercent: number; memoryPercent: number; capacityPercent: number; eventLoopLagMs?: number; sampledAt?: number },
): void {
	insertStmt.run(
		serverId,
		load.sampledAt ?? Date.now(),
		load.cpuPercent,
		load.memoryPercent,
		load.capacityPercent,
		load.eventLoopLagMs ?? null,
	);
}

/** Every sample from the last `hours`, oldest first, every server mixed together — callers group by serverId. */
export function listServerLoadSamples(hours: number, now: number = Date.now()): ServerLoadSample[] {
	const since = now - Math.max(0, hours) * 3_600_000;
	return listSinceStmt.all(since).map(fromRow);
}

const RETENTION_DAYS = 30;

/** Keeps the table from growing forever — a trend line has no use for
 * months-old minute-by-minute noise. Called once per recorder tick. */
export function pruneServerLoadSamples(now: number = Date.now()): void {
	pruneStmt.run(now - RETENTION_DAYS * 86_400_000);
}

// ---- Server 1 remote status (shared with api/routes/health.ts) ------------

export interface Server1Status {
	reachable: boolean;
	serviceHealthy: boolean;
	load?: ServerLoad;
	detail?: string;
}

const SERVER1_STATUS_URL = process.env.SERVER1_STATUS_URL ?? "http://10.77.0.1:8792/healthz";

/** Server 1 runs no bot/API code (see DEPLOY-README.md) — just this tiny
 * status agent (monitoring/server1-status-agent.ts) reachable over the
 * WireGuard tunnel. Shared by the live /api/health check and the slower
 * history recorder below so the fetch/parse logic exists exactly once. */
export async function fetchServer1Status(): Promise<Server1Status> {
	try {
		const res = await fetch(SERVER1_STATUS_URL, { signal: AbortSignal.timeout(1_500) });
		if (!res.ok) throw new Error(`status agent responded ${res.status}`);
		const status = (await res.json()) as { id?: string; serviceHealthy?: boolean; load?: ServerLoad; detail?: string };
		if (status.id !== "server1" || !status.load || typeof status.load.capacityPercent !== "number") {
			throw new Error("invalid status agent response");
		}
		return { reachable: true, serviceHealthy: status.serviceHealthy === true, load: status.load, detail: status.detail };
	} catch {
		return { reachable: false, serviceHealthy: false, detail: "ไม่สามารถติดต่อ Server 1 ผ่าน WireGuard" };
	}
}

// ---- Background recorder ---------------------------------------------------

const RECORD_INTERVAL_MS = Math.max(10_000, Number(process.env.SERVER_LOAD_HISTORY_INTERVAL_MS ?? 30_000));

let started = false;

/**
 * Snapshots all three machines into server_load_samples on one shared clock,
 * for the dashboard's Servers tab trend graphs. Deliberately coarser than
 * system-load.ts's 5s in-process monitor — this table exists to draw a
 * trend, not to drive alerting, and every worker recording "server2"
 * independently would double-count one physical machine's load.
 */
export function startServerLoadHistoryRecorder(): void {
	if (started || process.env.NODE_ENV === "test" || !shouldRunControlPlaneJobs()) return;
	started = true;

	async function tick(): Promise<void> {
		const now = Date.now();
		const local = getSystemLoadSnapshot();
		recordServerLoadSample("server2", { ...local, eventLoopLagMs: local.eventLoopLagMs, sampledAt: now });

		const server1 = await fetchServer1Status();
		if (server1.load) recordServerLoadSample("server1", server1.load);

		const server3 = latestRemoteServerLoad();
		if (server3) recordServerLoadSample("server3", server3);

		pruneServerLoadSamples(now);
	}

	void tick();
	const timer = setInterval(() => void tick(), RECORD_INTERVAL_MS);
	timer.unref?.();
}
