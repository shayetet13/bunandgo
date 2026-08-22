import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveWorkerScope } from "./worker-scope.ts";
import {
	assignedWorkerForOwner,
	listOwnerWorkerAssignments,
	parseAssignmentWorkers,
	STICKY_ASSIGNMENT_MODE,
	stickyAssignmentEnabled,
} from "./worker-assignment.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export interface WorkerTopology {
	workerId: string;
	ownerRoutes: Map<number, URL>;
	workerRoutes: Map<string, URL>;
	assignmentMode?: typeof STICKY_ASSIGNMENT_MODE;
	controlPlaneUrl?: URL;
	controlPlaneToken?: string;
}

interface RuntimeWorkerTuning {
	fastPollIntervalMs?: number;
	h2Lanes?: number;
	laneSource?: "local" | "relay";
	relayLanes?: number;
	relayUrl?: string;
	relayToken?: string;
	sendReservedLanes?: number;
	fastPollSlots?: number;
	pollExploreIntervalMs?: number;
	pollCalibrationSamples?: number;
	applicationHotCeilingMs?: number;
	applicationDiscardCeilingMs?: number;
	applicationSampleMaxAgeMs?: number;
	laneMaxAgeMs?: number;
	laneRecycleGapMs?: number;
	degradedRepairMinSamples?: number;
}

interface RuntimeTopologyPrimary extends RuntimeWorkerTuning {
	workerId: string;
	port: number;
}

interface RuntimeTopologyShard extends RuntimeWorkerTuning {
	workerId: string;
	port: number;
	ownerIds?: number[];
}

interface RuntimeTopologyFile {
	version: 1;
	assignmentMode?: typeof STICKY_ASSIGNMENT_MODE;
	primary: RuntimeTopologyPrimary;
	shards: RuntimeTopologyShard[];
	controlPlaneToken: string;
	relayReportToken?: string;
}

function positiveInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${label} must be a positive integer`);
	}
	return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${label} must be a non-negative integer`);
	}
	return value;
}

function positiveNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${label} must be a positive number`);
	}
	return value;
}

function validateWorkerTuning(worker: RuntimeWorkerTuning, label: string): void {
	const interval =
		worker.fastPollIntervalMs === undefined ? undefined : nonNegativeInteger(worker.fastPollIntervalMs, `${label} fastPollIntervalMs`);
	if (interval !== undefined && interval > 0 && interval < 50) {
		throw new Error("worker topology fastPollIntervalMs must be zero-delay or at least 50ms");
	}
	const h2Lanes = worker.h2Lanes === undefined ? undefined : nonNegativeInteger(worker.h2Lanes, `${label} h2Lanes`);
	if (h2Lanes !== undefined && h2Lanes > 32) throw new Error(`${label} h2Lanes cannot exceed 32`);
	const relayLanes = worker.relayLanes === undefined ? undefined : positiveInteger(worker.relayLanes, `${label} relayLanes`);
	if (relayLanes !== undefined && relayLanes > 32) throw new Error(`${label} relayLanes cannot exceed 32`);
	const laneSource = worker.laneSource ?? "local";
	if (laneSource !== "local" && laneSource !== "relay") throw new Error(`${label} laneSource must be local or relay`);
	const hasRelayConfiguration =
		laneSource === "relay" || relayLanes !== undefined || worker.relayUrl !== undefined || worker.relayToken !== undefined;
	if (hasRelayConfiguration) {
		if (relayLanes === undefined) throw new Error(`${label} relay configuration requires relayLanes`);
		if (!worker.relayUrl) throw new Error(`${label} relay configuration requires relayUrl`);
		let relayUrl: URL;
		try {
			relayUrl = new URL(worker.relayUrl);
		} catch {
			throw new Error(`${label} relayUrl must be a valid URL`);
		}
		if (
			relayUrl.protocol !== "http:" ||
			relayUrl.pathname !== "/dispatch" ||
			relayUrl.username ||
			relayUrl.password ||
			relayUrl.search ||
			relayUrl.hash
		) {
			throw new Error(`${label} relayUrl must be a plain HTTP /dispatch endpoint without credentials, query, or fragment`);
		}
		if ((worker.relayToken?.length ?? 0) < 32) throw new Error(`${label} relayToken must contain at least 32 characters`);
	}
	const effectiveLanes = laneSource === "relay" ? relayLanes : h2Lanes;
	const reserved =
		worker.sendReservedLanes === undefined ? undefined : positiveInteger(worker.sendReservedLanes, `${label} sendReservedLanes`);
	const slots = worker.fastPollSlots === undefined ? undefined : positiveInteger(worker.fastPollSlots, `${label} fastPollSlots`);
	const exploreInterval =
		worker.pollExploreIntervalMs === undefined
			? undefined
			: positiveInteger(worker.pollExploreIntervalMs, `${label} pollExploreIntervalMs`);
	if (worker.pollCalibrationSamples !== undefined) {
		positiveInteger(worker.pollCalibrationSamples, `${label} pollCalibrationSamples`);
	}
	const hotCeiling =
		worker.applicationHotCeilingMs === undefined
			? undefined
			: positiveNumber(worker.applicationHotCeilingMs, `${label} applicationHotCeilingMs`);
	const discardCeiling =
		worker.applicationDiscardCeilingMs === undefined
			? undefined
			: positiveNumber(worker.applicationDiscardCeilingMs, `${label} applicationDiscardCeilingMs`);
	const sampleMaxAge =
		worker.applicationSampleMaxAgeMs === undefined
			? undefined
			: positiveInteger(worker.applicationSampleMaxAgeMs, `${label} applicationSampleMaxAgeMs`);
	const laneMaxAge = worker.laneMaxAgeMs === undefined ? undefined : positiveInteger(worker.laneMaxAgeMs, `${label} laneMaxAgeMs`);
	const recycleGap =
		worker.laneRecycleGapMs === undefined ? undefined : positiveInteger(worker.laneRecycleGapMs, `${label} laneRecycleGapMs`);
	if (worker.degradedRepairMinSamples !== undefined) {
		positiveInteger(worker.degradedRepairMinSamples, `${label} degradedRepairMinSamples`);
	}
	if (effectiveLanes !== undefined && reserved !== undefined && reserved >= effectiveLanes) {
		throw new Error(`${label} sendReservedLanes must leave at least one poll lane`);
	}
	if (effectiveLanes !== undefined && reserved !== undefined && slots !== undefined && slots > effectiveLanes - reserved) {
		throw new Error(`${label} fastPollSlots cannot exceed the non-send H2 lane count`);
	}
	if (interval === 0 && (effectiveLanes === undefined || reserved === undefined || slots === undefined)) {
		throw new Error(`${label} zero-delay requires an effective lane count, sendReservedLanes, and fastPollSlots`);
	}
	if (hotCeiling !== undefined && discardCeiling !== undefined && hotCeiling >= discardCeiling) {
		throw new Error(`${label} applicationHotCeilingMs must be lower than applicationDiscardCeilingMs`);
	}
	if (
		effectiveLanes !== undefined &&
		reserved !== undefined &&
		exploreInterval !== undefined &&
		sampleMaxAge !== undefined &&
		(effectiveLanes - reserved) * exploreInterval >= sampleMaxAge
	) {
		throw new Error(`${label} poll exploration must sweep every poll lane before application samples expire`);
	}
	if (h2Lanes !== undefined && laneMaxAge !== undefined && recycleGap !== undefined && h2Lanes * recycleGap > laneMaxAge) {
		throw new Error(`${label} lane recycling cannot cover the pool before laneMaxAgeMs`);
	}
}

function parseRuntimeTopologyFile(raw: string): RuntimeTopologyFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("worker topology file must contain valid JSON");
	}
	if (!parsed || typeof parsed !== "object") throw new Error("worker topology file must contain an object");
	const value = parsed as Partial<RuntimeTopologyFile>;
	if (value.version !== 1) throw new Error("worker topology file version must be 1");
	if (!value.primary || typeof value.primary !== "object") throw new Error("worker topology file needs primary");
	if (!Array.isArray(value.shards) || value.shards.length === 0) throw new Error("worker topology file needs at least one shard");
	if (typeof value.controlPlaneToken !== "string" || value.controlPlaneToken.length < 32) {
		throw new Error("worker topology controlPlaneToken must contain at least 32 characters");
	}
	if (value.assignmentMode !== undefined && value.assignmentMode !== STICKY_ASSIGNMENT_MODE) {
		throw new Error(`worker topology assignmentMode must be ${STICKY_ASSIGNMENT_MODE}`);
	}
	const sticky = value.assignmentMode === STICKY_ASSIGNMENT_MODE;
	if (sticky && (value.relayReportToken?.length ?? 0) < 32) {
		throw new Error("worker topology relayReportToken must contain at least 32 characters");
	}

	const primaryPort = positiveInteger(value.primary.port, "worker topology primary.port");
	if (!value.primary.workerId?.trim()) throw new Error("worker topology primary.workerId is required");
	validateWorkerTuning(value.primary, "worker topology primary");
	const ports = new Set<number>([primaryPort]);
	const workers = new Set<string>([value.primary.workerId]);
	const owners = new Set<number>();
	for (const shard of value.shards) {
		if (!shard || typeof shard !== "object") throw new Error("worker topology shard must be an object");
		const port = positiveInteger(shard.port, "worker topology shard.port");
		if (ports.has(port)) throw new Error(`worker topology port ${port} is assigned more than once`);
		ports.add(port);
		if (!shard.workerId?.trim()) throw new Error("worker topology shard.workerId is required");
		if (workers.has(shard.workerId)) throw new Error(`worker topology workerId ${shard.workerId} is assigned more than once`);
		workers.add(shard.workerId);
		if (!sticky && (!Array.isArray(shard.ownerIds) || shard.ownerIds.length === 0)) {
			throw new Error(`worker topology shard ${shard.workerId} needs ownerIds`);
		}
		if (shard.ownerIds !== undefined && !Array.isArray(shard.ownerIds)) {
			throw new Error(`worker topology shard ${shard.workerId} ownerIds must be an array`);
		}
		for (const rawOwnerId of shard.ownerIds ?? []) {
			const ownerId = positiveInteger(rawOwnerId, `worker topology shard ${shard.workerId} owner id`);
			if (owners.has(ownerId)) throw new Error(`worker topology owner ${ownerId} is assigned more than once`);
			owners.add(ownerId);
		}
		validateWorkerTuning(shard, `worker topology shard ${shard.workerId}`);
	}
	return value as RuntimeTopologyFile;
}

function runtimeTopologyPath(): string | undefined {
	const explicit = process.env.WORKER_TOPOLOGY_FILE?.trim();
	if (explicit) return explicit;
	if (process.env.NODE_ENV !== "production") return undefined;
	const dbPath = process.env.DB_PATH?.trim();
	return dbPath ? join(dirname(dbPath), "worker-topology.json") : undefined;
}

/**
 * Applies the shared, atomic worker assignment before any LINE session or API
 * module starts. This is a production-safe escape hatch when the deploy user
 * can update /opt/linebot/shared but cannot rewrite root-owned EnvironmentFile
 * files. A malformed file fails the process closed in validateWorkerTopology.
 */
export function applyRuntimeTopologyFile(raw?: string): boolean {
	const path = raw === undefined ? runtimeTopologyPath() : undefined;
	if (raw === undefined && !path) return false;
	let contents = raw;
	if (contents === undefined) {
		try {
			contents = readFileSync(path!, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}
	const topology = parseRuntimeTopologyFile(contents);
	const port = positiveInteger(Number(process.env.PORT), "PORT");
	const ownerIds = topology.shards.flatMap((shard) => shard.ownerIds ?? []).sort((a, b) => a - b);
	const primaryOrigin = `http://127.0.0.1:${topology.primary.port}`;
	const shard = topology.shards.find((candidate) => candidate.port === port);
	const sticky = topology.assignmentMode === STICKY_ASSIGNMENT_MODE;

	process.env.CONTROL_PLANE_TOKEN = topology.controlPlaneToken;
	if (topology.relayReportToken) process.env.LANE_RELAY_TOKEN = topology.relayReportToken;
	if (sticky) {
		process.env.WORKER_ASSIGNMENT_MODE = STICKY_ASSIGNMENT_MODE;
		process.env.WORKER_PRIMARY_ID = topology.primary.workerId;
		process.env.WORKER_ASSIGNMENT_WORKERS = [topology.primary.workerId, ...topology.shards.map((item) => item.workerId)].join(",");
	} else {
		delete process.env.WORKER_ASSIGNMENT_MODE;
		delete process.env.WORKER_PRIMARY_ID;
		delete process.env.WORKER_ASSIGNMENT_WORKERS;
		delete process.env.WORKER_ROUTES;
	}
	const applyTuning = (worker: RuntimeWorkerTuning, defaultInterval: number): void => {
		const interval = worker.fastPollIntervalMs ?? defaultInterval;
		process.env.SQUARE_FAST_POLL_INTERVAL_MS = String(interval);
		if (interval === 50) process.env.SQUARE_FAST_POLL_ALLOW_50MS = "1";
		else delete process.env.SQUARE_FAST_POLL_ALLOW_50MS;
		if (interval === 0) process.env.SQUARE_FAST_POLL_ALLOW_ZERO_MS = "1";
		else delete process.env.SQUARE_FAST_POLL_ALLOW_ZERO_MS;
		if (worker.h2Lanes !== undefined) process.env.LINE_H2_LANES = String(worker.h2Lanes);
		if (worker.laneSource === "relay") {
			process.env.LINE_RELAY_MODE = "always";
			process.env.LINE_EFFECTIVE_H2_LANES = String(worker.relayLanes);
			process.env.LINE_RELAY_URL = worker.relayUrl!;
			process.env.LINE_RELAY_TOKEN = worker.relayToken!;
		} else {
			delete process.env.LINE_RELAY_MODE;
			if (worker.relayUrl && worker.relayToken) {
				process.env.LINE_RELAY_URL = worker.relayUrl;
				process.env.LINE_RELAY_TOKEN = worker.relayToken;
			} else {
				delete process.env.LINE_RELAY_URL;
				delete process.env.LINE_RELAY_TOKEN;
			}
			if (worker.h2Lanes !== undefined) process.env.LINE_EFFECTIVE_H2_LANES = String(worker.h2Lanes);
		}
		if (worker.sendReservedLanes !== undefined) process.env.LINE_H2_SEND_RESERVED_LANES = String(worker.sendReservedLanes);
		if (worker.fastPollSlots !== undefined) process.env.SQUARE_FAST_POLL_SLOTS = String(worker.fastPollSlots);
		if (worker.pollExploreIntervalMs !== undefined) process.env.LINE_H2_POLL_EXPLORE_INTERVAL_MS = String(worker.pollExploreIntervalMs);
		if (worker.pollCalibrationSamples !== undefined) process.env.LINE_H2_POLL_CALIBRATION_SAMPLES = String(worker.pollCalibrationSamples);
		if (worker.applicationHotCeilingMs !== undefined)
			process.env.LINE_H2_APPLICATION_HOT_CEILING_MS = String(worker.applicationHotCeilingMs);
		if (worker.applicationDiscardCeilingMs !== undefined)
			process.env.LINE_H2_APPLICATION_DISCARD_CEILING_MS = String(worker.applicationDiscardCeilingMs);
		if (worker.applicationSampleMaxAgeMs !== undefined)
			process.env.LINE_H2_APPLICATION_SAMPLE_MAX_AGE_MS = String(worker.applicationSampleMaxAgeMs);
		if (worker.laneMaxAgeMs !== undefined) process.env.LINE_H2_LANE_MAX_AGE_MS = String(worker.laneMaxAgeMs);
		if (worker.laneRecycleGapMs !== undefined) process.env.LINE_H2_LANE_RECYCLE_GAP_MS = String(worker.laneRecycleGapMs);
		if (worker.degradedRepairMinSamples !== undefined)
			process.env.LINE_H2_DEGRADED_REPAIR_MIN_SAMPLES = String(worker.degradedRepairMinSamples);
	};
	if (port === topology.primary.port) {
		process.env.WORKER_ID = topology.primary.workerId;
		delete process.env.WORKER_OWNER_SCOPE;
		if (sticky) {
			delete process.env.WORKER_OWNER_EXCLUDE;
			delete process.env.WORKER_OWNER_ROUTES;
			process.env.WORKER_ROUTES = topology.shards.map((candidate) => `${candidate.workerId}=http://127.0.0.1:${candidate.port}`).join(",");
		} else {
			process.env.WORKER_OWNER_EXCLUDE = ownerIds.join(",");
			process.env.WORKER_OWNER_ROUTES = topology.shards
				.flatMap((candidate) => (candidate.ownerIds ?? []).map((ownerId) => `${ownerId}=http://127.0.0.1:${candidate.port}`))
				.sort((left, right) => Number(left.split("=", 1)[0]) - Number(right.split("=", 1)[0]))
				.join(",");
		}
		delete process.env.CONTROL_PLANE_URL;
		applyTuning(topology.primary, 100);
		return true;
	}
	if (!shard) throw new Error(`worker topology file has no worker for PORT ${port}`);
	process.env.WORKER_ID = shard.workerId;
	if (sticky) delete process.env.WORKER_OWNER_SCOPE;
	else process.env.WORKER_OWNER_SCOPE = [...(shard.ownerIds ?? [])].sort((a, b) => a - b).join(",");
	delete process.env.WORKER_OWNER_EXCLUDE;
	delete process.env.WORKER_OWNER_ROUTES;
	delete process.env.WORKER_ROUTES;
	process.env.CONTROL_PLANE_URL = primaryOrigin;
	applyTuning(shard, 100);
	return true;
}

function parseLoopbackHttpUrl(raw: string, envName: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`${envName} must be a valid URL`);
	}
	if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
		throw new Error(`${envName} must use http:// on loopback (127.0.0.1, localhost, or ::1)`);
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error(`${envName} must not contain credentials, a query, or a fragment`);
	}
	url.pathname = url.pathname.replace(/\/+$/, "") || "/";
	return url;
}

export function parseWorkerOwnerRoutes(raw: string | undefined): Map<number, URL> {
	const routes = new Map<number, URL>();
	if (!raw?.trim()) return routes;
	for (const entry of raw.split(",")) {
		const separator = entry.indexOf("=");
		if (separator <= 0) throw new Error(`WORKER_OWNER_ROUTES entry must be ownerId=http://loopback:port: ${entry.trim()}`);
		const ownerRaw = entry.slice(0, separator).trim();
		const ownerId = Number(ownerRaw);
		if (!/^[1-9]\d*$/.test(ownerRaw) || !Number.isSafeInteger(ownerId)) {
			throw new Error(`WORKER_OWNER_ROUTES contains an invalid owner id: ${ownerRaw}`);
		}
		if (routes.has(ownerId)) throw new Error(`WORKER_OWNER_ROUTES contains owner ${ownerId} more than once`);
		const url = parseLoopbackHttpUrl(entry.slice(separator + 1).trim(), `WORKER_OWNER_ROUTES owner ${ownerId}`);
		routes.set(ownerId, url);
	}
	return routes;
}

export function parseWorkerRoutes(raw: string | undefined): Map<string, URL> {
	const routes = new Map<string, URL>();
	if (!raw?.trim()) return routes;
	for (const entry of raw.split(",")) {
		const separator = entry.indexOf("=");
		const workerId = entry.slice(0, separator).trim();
		if (separator <= 0 || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(workerId)) {
			throw new Error(`WORKER_ROUTES entry must be workerId=http://loopback:port: ${entry.trim()}`);
		}
		if (routes.has(workerId)) throw new Error(`WORKER_ROUTES contains worker ${workerId} more than once`);
		routes.set(workerId, parseLoopbackHttpUrl(entry.slice(separator + 1).trim(), `WORKER_ROUTES worker ${workerId}`));
	}
	return routes;
}

export function readWorkerTopology(): WorkerTopology {
	const controlPlaneRaw = process.env.CONTROL_PLANE_URL?.trim();
	const workerId = process.env.WORKER_ID?.trim() || "standalone";
	const workerRoutes = parseWorkerRoutes(process.env.WORKER_ROUTES);
	const ownerRoutes = parseWorkerOwnerRoutes(process.env.WORKER_OWNER_ROUTES);
	if (stickyAssignmentEnabled()) {
		for (const [ownerId, assignedWorker] of listOwnerWorkerAssignments()) {
			if (assignedWorker !== workerId && workerRoutes.has(assignedWorker)) {
				ownerRoutes.set(ownerId, workerRoutes.get(assignedWorker)!);
			}
		}
	}
	return {
		workerId,
		ownerRoutes,
		workerRoutes,
		assignmentMode: stickyAssignmentEnabled() ? STICKY_ASSIGNMENT_MODE : undefined,
		controlPlaneUrl: controlPlaneRaw ? parseLoopbackHttpUrl(controlPlaneRaw, "CONTROL_PLANE_URL") : undefined,
		controlPlaneToken: process.env.CONTROL_PLANE_TOKEN?.trim() || undefined,
	};
}

function sameIds(left: Set<number>, right: Set<number>): boolean {
	return left.size === right.size && [...left].every((id) => right.has(id));
}

/**
 * Refuse an incomplete split at boot. Without this check a catch-all worker
 * and a scoped worker can both log in the same LINE account, while the public
 * API continues talking only to the catch-all process. That overlap is more
 * dangerous than staying offline until the operator fixes the env files.
 */
export function validateWorkerTopology(): WorkerTopology {
	applyRuntimeTopologyFile();
	const topology = readWorkerTopology();
	const scope = resolveWorkerScope();
	const routedOwners = new Set(topology.ownerRoutes.keys());
	const tokenOkay = (topology.controlPlaneToken?.length ?? 0) >= 32;
	const splitEnabled = topology.ownerRoutes.size > 0 || !!topology.controlPlaneUrl;
	if (topology.assignmentMode) {
		const workers = parseAssignmentWorkers();
		const knownWorkers = new Set(workers);
		const primaryWorker = process.env.WORKER_PRIMARY_ID?.trim();
		if (!primaryWorker || workers[0] !== primaryWorker) {
			throw new Error("WORKER_PRIMARY_ID must equal the first WORKER_ASSIGNMENT_WORKERS entry");
		}
		if (!workers.includes(topology.workerId)) throw new Error("WORKER_ID is not present in WORKER_ASSIGNMENT_WORKERS");
		for (const [ownerId, assignedWorker] of listOwnerWorkerAssignments()) {
			if (!knownWorkers.has(assignedWorker)) {
				throw new Error(`owner ${ownerId} is assigned to unknown worker ${assignedWorker}`);
			}
		}
		if (scope.include || scope.exclude) throw new Error("balanced-sticky assignment cannot use static owner scope lists");
		if (!tokenOkay) throw new Error("CONTROL_PLANE_TOKEN must be at least 32 characters for balanced-sticky assignment");
		if (topology.workerId === primaryWorker) {
			if (topology.controlPlaneUrl) throw new Error("Primary cannot set CONTROL_PLANE_URL");
			for (const worker of workers.slice(1)) {
				if (!topology.workerRoutes.has(worker)) throw new Error(`WORKER_ROUTES is missing ${worker}`);
			}
		} else {
			if (!topology.controlPlaneUrl) throw new Error("A sticky shard requires CONTROL_PLANE_URL");
			if (topology.workerRoutes.size > 0) throw new Error("A sticky shard cannot set WORKER_ROUTES");
		}
	}
	if (process.env.LINE_RELAY_MODE === "always") {
		if (!process.env.LINE_RELAY_URL?.trim() || !process.env.LINE_RELAY_TOKEN?.trim()) {
			throw new Error("LINE_RELAY_MODE=always requires LINE_RELAY_URL and LINE_RELAY_TOKEN");
		}
		if (Number(process.env.LINE_H2_LANES) !== 0) {
			throw new Error("LINE_RELAY_MODE=always requires LINE_H2_LANES=0 to keep egress pinned");
		}
	}
	if ((splitEnabled || topology.assignmentMode) && !process.env.WORKER_ID?.trim()) {
		throw new Error("WORKER_ID is required for every control-plane or shard process");
	}

	if (!topology.assignmentMode && topology.ownerRoutes.size > 0) {
		if (scope.include) throw new Error("A control-plane worker cannot set WORKER_OWNER_SCOPE");
		if (!scope.exclude || !sameIds(scope.exclude, routedOwners)) {
			throw new Error("WORKER_OWNER_EXCLUDE must exactly match the owner ids in WORKER_OWNER_ROUTES");
		}
		if (topology.controlPlaneUrl) throw new Error("A control-plane worker cannot also set CONTROL_PLANE_URL");
		if (!tokenOkay) throw new Error("CONTROL_PLANE_TOKEN must be at least 32 characters when WORKER_OWNER_ROUTES is set");
	}

	if (!topology.assignmentMode && topology.controlPlaneUrl) {
		if (!scope.include || scope.exclude) throw new Error("A shard with CONTROL_PLANE_URL must set WORKER_OWNER_SCOPE only");
		if (topology.ownerRoutes.size > 0) throw new Error("A shard cannot set WORKER_OWNER_ROUTES");
		if (!tokenOkay) throw new Error("CONTROL_PLANE_TOKEN must be at least 32 characters when CONTROL_PLANE_URL is set");
	}

	if (!topology.assignmentMode && scope.exclude && topology.ownerRoutes.size === 0) {
		throw new Error("WORKER_OWNER_EXCLUDE requires WORKER_OWNER_ROUTES so excluded owners remain controllable");
	}
	if (!topology.assignmentMode && scope.include && !topology.controlPlaneUrl) {
		throw new Error("WORKER_OWNER_SCOPE requires CONTROL_PLANE_URL so shard events reach the public control plane");
	}

	const ownPort = Number(process.env.PORT);
	for (const [ownerId, route] of topology.ownerRoutes) {
		const routePort = Number(route.port || "80");
		if (Number.isInteger(ownPort) && ownPort === routePort) {
			throw new Error(`WORKER_OWNER_ROUTES owner ${ownerId} points back to this worker's own PORT`);
		}
	}
	for (const [workerId, route] of topology.workerRoutes) {
		const routePort = Number(route.port || "80");
		if (Number.isInteger(ownPort) && ownPort === routePort) {
			throw new Error(`WORKER_ROUTES worker ${workerId} points back to this worker's own PORT`);
		}
	}
	if (topology.controlPlaneUrl) {
		const controlPort = Number(topology.controlPlaneUrl.port || "80");
		if (Number.isInteger(ownPort) && ownPort === controlPort) {
			throw new Error("CONTROL_PLANE_URL points back to this worker's own PORT");
		}
	}

	return topology;
}

export function isControlPlane(): boolean {
	const topology = readWorkerTopology();
	return topology.assignmentMode ? topology.workerId === process.env.WORKER_PRIMARY_ID?.trim() : topology.ownerRoutes.size > 0;
}

export function shouldRunControlPlaneJobs(): boolean {
	return !readWorkerTopology().controlPlaneUrl;
}

export function workerUrlForOwner(ownerUserId: number | null): URL | undefined {
	if (ownerUserId === null) return undefined;
	const topology = readWorkerTopology();
	if (!topology.assignmentMode) return topology.ownerRoutes.get(ownerUserId);
	const assignedWorker = assignedWorkerForOwner(ownerUserId);
	return assignedWorker && assignedWorker !== topology.workerId ? topology.workerRoutes.get(assignedWorker) : undefined;
}
