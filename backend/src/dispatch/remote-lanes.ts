import { readFileSync } from "node:fs";
import { decodeDispatchResponse, encodeDispatchRequest } from "./binary-protocol.ts";
import { attachRawDispatchBody } from "./raw-response.ts";
import {
	H2_LANE_ROLE_HEADER,
	laneFetch,
	laneStats,
	type LaneStat,
} from "./h2-lanes.ts";
import { LANE_NODE_TOKEN_HEADER } from "./lane-node-server.ts";

type LaneRole = "send" | "poll";
type DistributedRoute = "local" | "remote";

export interface RemoteLaneSnapshot {
	nodeId: string;
	sampledAt: number;
	receivedAt: number;
	rpcRttMs: number;
	lanes: LaneStat[];
}

export interface DistributedRouteInput {
	localScoreMs?: number;
	remoteApplicationMs?: number;
	remoteRpcMs?: number;
	remoteInFlight?: number;
	marginMs?: number;
}

const REMOTE_CONFIG_FILE = process.env.REMOTE_LANE_CONFIG_FILE?.trim() ||
	"/opt/linebot/shared/remote-lane.env";
const REMOTE_CONFIG_KEYS = new Set([
	"REMOTE_LANE_URL",
	"REMOTE_LANE_TOKEN",
	"REMOTE_LANE_SEND_ENABLED",
	"REMOTE_LANE_POLL_CANARY",
	"REMOTE_LANE_MONITOR_INTERVAL_MS",
	"REMOTE_LANE_SNAPSHOT_MAX_AGE_MS",
	"REMOTE_LANE_POLL_CANARY_INTERVAL_MS",
	"REMOTE_LANE_SWITCH_MARGIN_MS",
	"LINE_H2_IN_FLIGHT_PENALTY_MS",
]);

export function parseRemoteLaneConfig(content: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const rawLine of content.split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		if (separator <= 0) continue;
		const key = line.slice(0, separator).trim();
		if (!REMOTE_CONFIG_KEYS.has(key)) continue;
		values[key] = line.slice(separator + 1).trim();
	}
	return values;
}

function readRemoteLaneConfig(): Record<string, string> {
	try {
		return parseRemoteLaneConfig(readFileSync(REMOTE_CONFIG_FILE, "utf8"));
	} catch {
		return {};
	}
}

const fileConfig = readRemoteLaneConfig();
function setting(name: string): string | undefined {
	return process.env[name]?.trim() || fileConfig[name]?.trim();
}

const REMOTE_URL = setting("REMOTE_LANE_URL");
const REMOTE_TOKEN = setting("REMOTE_LANE_TOKEN");
const REMOTE_SEND_ENABLED = setting("REMOTE_LANE_SEND_ENABLED") === "1";
const REMOTE_POLL_CANARY_ENABLED = setting("REMOTE_LANE_POLL_CANARY") === "1";
const MONITOR_INTERVAL_MS = Math.max(100, Number(setting("REMOTE_LANE_MONITOR_INTERVAL_MS") ?? 250));
const SNAPSHOT_MAX_AGE_MS = Math.max(500, Number(setting("REMOTE_LANE_SNAPSHOT_MAX_AGE_MS") ?? 1_500));
const POLL_CANARY_INTERVAL_MS = Math.max(250, Number(setting("REMOTE_LANE_POLL_CANARY_INTERVAL_MS") ?? 2_000));
const SWITCH_MARGIN_MS = Math.max(0, Number(setting("REMOTE_LANE_SWITCH_MARGIN_MS") ?? 0.5));
const IN_FLIGHT_PENALTY_MS = Math.max(0, Number(setting("LINE_H2_IN_FLIGHT_PENALTY_MS") ?? 4));

let monitorStarted = false;
let monitorTimer: ReturnType<typeof setInterval> | undefined;
let monitorInFlight = false;
let snapshot: RemoteLaneSnapshot | undefined;
let consecutiveMonitorFailures = 0;
let nextPollCanaryAt = 0;

function configured(): boolean {
	return Boolean(REMOTE_URL && REMOTE_TOKEN && REMOTE_TOKEN.length >= 32);
}

function requestRole(info: RequestInfo | URL, init?: RequestInit): LaneRole {
	const headers = new Headers(init?.headers ?? (info instanceof Request ? info.headers : undefined));
	return headers.get(H2_LANE_ROLE_HEADER)?.toLowerCase() === "poll" ? "poll" : "send";
}

function freshHotScore(lanes: readonly LaneStat[], now: number): number | undefined {
	const scores = lanes
		.filter((lane) =>
			lane.state === "ready" && lane.routingEligible && lane.applicationRttMs !== undefined &&
			now - lane.applicationSampleAt <= 30_000
		)
		.map((lane) => lane.applicationRttMs! + lane.inFlight * IN_FLIGHT_PENALTY_MS);
	return scores.length > 0 ? Math.min(...scores) : undefined;
}

function bestRemoteLane(lanes: readonly LaneStat[], now: number): LaneStat | undefined {
	return lanes
		.filter((lane) =>
			lane.state === "ready" && lane.routingEligible && lane.applicationRttMs !== undefined &&
			now - lane.applicationSampleAt <= 30_000
		)
		.sort((left, right) =>
			(left.applicationRttMs! + left.inFlight * IN_FLIGHT_PENALTY_MS) -
			(right.applicationRttMs! + right.inFlight * IN_FLIGHT_PENALTY_MS)
		)[0];
}

export function selectDistributedRoute(input: DistributedRouteInput): DistributedRoute {
	if (input.remoteApplicationMs === undefined || input.remoteRpcMs === undefined) return "local";
	const remoteScore = input.remoteApplicationMs + input.remoteRpcMs +
		(input.remoteInFlight ?? 0) * IN_FLIGHT_PENALTY_MS;
	if (input.localScoreMs === undefined) return "remote";
	return remoteScore + (input.marginMs ?? 0.5) < input.localScoreMs ? "remote" : "local";
}

async function refreshSnapshot(): Promise<void> {
	if (!configured() || monitorInFlight) return;
	monitorInFlight = true;
	const startedAt = performance.now();
	try {
		const endpoint = new URL("/v1/stats", REMOTE_URL);
		const response = await fetch(endpoint, {
			headers: { [LANE_NODE_TOKEN_HEADER]: REMOTE_TOKEN! },
			signal: AbortSignal.timeout(Math.max(500, MONITOR_INTERVAL_MS * 2)),
		});
		if (!response.ok) throw new Error(`stats HTTP ${response.status}`);
		const body = await response.json() as {
			nodeId: string;
			sampledAt: number;
			lanes: LaneStat[];
		};
		const measuredRpcMs = performance.now() - startedAt;
		snapshot = {
			nodeId: body.nodeId,
			sampledAt: body.sampledAt,
			receivedAt: Date.now(),
			rpcRttMs: snapshot === undefined ? measuredRpcMs : snapshot.rpcRttMs * 0.7 + measuredRpcMs * 0.3,
			lanes: body.lanes,
		};
		consecutiveMonitorFailures = 0;
	} catch {
		consecutiveMonitorFailures++;
		if (consecutiveMonitorFailures >= 2) snapshot = undefined;
	} finally {
		monitorInFlight = false;
	}
}

export function startRemoteLaneMonitor(): void {
	if (monitorStarted || !configured()) return;
	monitorStarted = true;
	void refreshSnapshot();
	monitorTimer = setInterval(() => void refreshSnapshot(), MONITOR_INTERVAL_MS);
	monitorTimer.unref?.();
}

export function stopRemoteLaneMonitor(): void {
	if (monitorTimer) clearInterval(monitorTimer);
	monitorTimer = undefined;
	monitorStarted = false;
	snapshot = undefined;
	consecutiveMonitorFailures = 0;
}

function shouldUseRemote(role: LaneRole, now: number): boolean {
	if (!snapshot || now - snapshot.receivedAt > SNAPSHOT_MAX_AGE_MS) return false;
	if (role === "poll" && REMOTE_POLL_CANARY_ENABLED && now >= nextPollCanaryAt) {
		nextPollCanaryAt = now + POLL_CANARY_INTERVAL_MS;
		return snapshot.lanes.some((lane) => lane.state === "ready");
	}
	if (role !== "send" || !REMOTE_SEND_ENABLED) return false;
	const remote = bestRemoteLane(snapshot.lanes, now);
	if (!remote) return false;
	return selectDistributedRoute({
		localScoreMs: freshHotScore(laneStats(), now),
		remoteApplicationMs: remote.applicationRttMs,
		remoteRpcMs: snapshot.rpcRttMs,
		remoteInFlight: remote.inFlight,
		marginMs: SWITCH_MARGIN_MS,
	}) === "remote";
}

function requestHeaders(request: Request): Record<string, string> {
	const headers: Record<string, string> = {};
	request.headers.forEach((value, key) => {
		headers[key] = value;
	});
	return headers;
}

async function remoteLaneFetch(info: RequestInfo | URL, init?: RequestInit): Promise<Response | undefined> {
	const request = info instanceof Request ? info.clone() : new Request(info, init);
	const wire = encodeDispatchRequest({
		method: request.method,
		url: request.url,
		headers: requestHeaders(request),
		body: request.body ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array(),
	});
	const endpoint = new URL("/v1/dispatch", REMOTE_URL!);
	const response = await fetch(endpoint, {
		method: "POST",
		headers: {
			"content-type": "application/octet-stream",
			[LANE_NODE_TOKEN_HEADER]: REMOTE_TOKEN!,
		},
		body: wire.buffer as ArrayBuffer,
		signal: request.signal,
	});
	if (response.status === 503 && response.headers.get("x-lane-node-not-started") === "1") return undefined;
	if (!response.ok) {
		// Never retry an ambiguous remote send on a local lane.
		throw new Error(`remote lane dispatch failed: HTTP ${response.status}`);
	}
	const decoded = decodeDispatchResponse(new Uint8Array(await response.arrayBuffer()));
	const headers = new Headers();
	for (const [key, values] of Object.entries(decoded.headers)) {
		for (const value of values) headers.append(key, value);
	}
	return attachRawDispatchBody(
		new Response(decoded.body as BodyInit, { status: decoded.status, headers }),
		decoded.body,
	);
}

/** Local stays byte-for-byte on the existing direct path unless cached data proves remote wins. */
export async function distributedLaneFetch(
	info: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response | undefined> {
	if (!configured()) return laneFetch(info, init);
	startRemoteLaneMonitor();
	const role = requestRole(info, init);
	if (!shouldUseRemote(role, Date.now())) return laneFetch(info, init);
	const remote = await remoteLaneFetch(info, init);
	return remote ?? laneFetch(info, init);
}

export function remoteLaneDiagnostics(): {
	configured: boolean;
	sendEnabled: boolean;
	pollCanaryEnabled: boolean;
	snapshot?: RemoteLaneSnapshot;
} {
	return { configured: configured(), sendEnabled: REMOTE_SEND_ENABLED, pollCanaryEnabled: REMOTE_POLL_CANARY_ENABLED, snapshot };
}
