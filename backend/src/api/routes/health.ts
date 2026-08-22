import { Hono } from "hono";
import { listBotsForUser } from "../../bot/bots.ts";
import { requestUser } from "../../auth/request-user.ts";
import { db } from "../../db/sqlite.ts";
import { laneStats } from "../../dispatch/h2-lanes.ts";
import { WORKER_ID } from "../../dispatch/lane-race.ts";
import { getSystemLoadSnapshot } from "../../monitoring/system-load.ts";
import { botEvents, getRuntimeDiagnostics } from "../../bot/session-manager.ts";
import { isControlPlane } from "../../bot/worker-topology.ts";
import { workerEventRelayDiagnostics } from "../worker-events.ts";
import { remoteLaneStats } from "../lane-relay-events.ts";
import { requireAdmin } from "../../auth/request-user.ts";

export const healthRoute = new Hono();
healthRoute.use("*", requireAdmin);

const DISPATCH_ADDR = process.env.DISPATCH_ADDR ?? "127.0.0.1:4790";
const SERVER1_STATUS_URL = process.env.SERVER1_STATUS_URL ?? "http://10.77.0.1:8792/healthz";
const processStartedAt = Date.now();

interface ServerLoad {
	cpuPercent: number;
	memoryPercent: number;
	capacityPercent: number;
	exceeded: boolean;
	sampledAt: number;
}

interface ServerStatus {
	id: "server1" | "server2";
	label: string;
	role: string;
	reachable: boolean;
	serviceHealthy: boolean;
	load?: ServerLoad;
	detail?: string;
}

async function checkSenderHealthy(): Promise<boolean> {
	try {
		const res = await fetch(`http://${DISPATCH_ADDR}/healthz`, { signal: AbortSignal.timeout(2000) });
		return res.ok;
	} catch {
		return false;
	}
}

function checkDbHealthy(): boolean {
	try {
		db.query("SELECT 1").get();
		return true;
	} catch {
		return false;
	}
}

function localServerStatus(senderHealthy: boolean, dbHealthy: boolean): ServerStatus {
	const load = getSystemLoadSnapshot();
	return {
		id: "server2",
		label: "Server 2",
		role: "Bot worker",
		reachable: true,
		serviceHealthy: senderHealthy && dbHealthy,
		load: {
			cpuPercent: load.cpuPercent,
			memoryPercent: load.memoryPercent,
			capacityPercent: load.capacityPercent,
			exceeded: load.exceeded,
			sampledAt: load.sampledAt,
		},
		detail: senderHealthy && dbHealthy ? "Bot worker และ sender ปกติ" : "Bot worker, sender หรือฐานข้อมูลมีปัญหา",
	};
}

async function server1Status(): Promise<ServerStatus> {
	try {
		const res = await fetch(SERVER1_STATUS_URL, { signal: AbortSignal.timeout(1_500) });
		if (!res.ok) throw new Error(`status agent responded ${res.status}`);
		const status = (await res.json()) as Partial<ServerStatus>;
		if (status.id !== "server1" || !status.load || typeof status.load.capacityPercent !== "number")
			throw new Error("invalid status agent response");
		return {
			id: "server1",
			label: "Server 1",
			role: "AWS gateway",
			reachable: true,
			serviceHealthy: status.serviceHealthy === true,
			load: status.load as ServerLoad,
			detail: status.detail,
		};
	} catch {
		return {
			id: "server1",
			label: "Server 1",
			role: "AWS gateway",
			reachable: false,
			serviceHealthy: false,
			detail: "ไม่สามารถติดต่อ Server 1 ผ่าน WireGuard",
		};
	}
}

healthRoute.get("/", async (c) => {
	const bots = listBotsForUser(requestUser(c)!, { includeAllWorkers: isControlPlane() });
	const [senderHealthy, server1] = await Promise.all([checkSenderHealthy(), server1Status()]);
	const dbHealthy = checkDbHealthy();
	return c.json({
		senderHealthy,
		dbHealthy,
		uptimeSeconds: Math.floor((Date.now() - processStartedAt) / 1000),
		botsOnline: bots.filter((b) => b.status === "online").length,
		botsTotal: bots.length,
		systemLoad: getSystemLoadSnapshot(),
		servers: [server1, localServerStatus(senderHealthy, dbHealthy)],
		// Surfaced so a reply riding the fetch fallback instead of an owned
		// lane is visible here rather than only as unexplained jitter on the
		// latency chart. Tagged with workerId and merged with whatever a lane
		// relay box (see backend/src/relay/) most recently reported, so a
		// second physical machine's lanes show up in the same list instead of
		// only this process's own.
		lanes: [...laneStats().map((lane) => ({ ...lane, workerId: WORKER_ID })), ...remoteLaneStats()],
		// One listener per open /ws connection per event name is normal. A
		// count that keeps climbing with the dashboard closed points at a
		// socket whose close handler never ran — see api/server.ts's
		// unsubscribe-on-close wiring. `botEvents.emit` runs synchronously on
		// every single reply, so a pile of dead listeners is a plausible read
		// on "gets slower the longer the process has been up," not just a
		// memory number nobody looks at.
		wsListeners: Object.fromEntries(botEvents.eventNames().map((name) => [String(name), botEvents.listenerCount(name)])),
		// heapUsed climbing = a real JS-level leak (something reachable that
		// should have been dropped). external/arrayBuffers climbing instead
		// points at native allocations (Buffers, TLS/socket internals) that
		// heapUsed alone would hide entirely — the two need telling apart
		// before chasing either one.
		memory: process.memoryUsage(),
		runtimeDiagnostics: getRuntimeDiagnostics(),
		workerEventRelay: workerEventRelayDiagnostics(),
	});
});
