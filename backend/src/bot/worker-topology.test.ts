import { afterEach, describe, expect, test } from "bun:test";
import { db } from "../db/sqlite.ts";
import {
	applyRuntimeTopologyFile,
	parseWorkerOwnerRoutes,
	parseWorkerRoutes,
	shouldRunControlPlaneJobs,
	validateWorkerTopology,
} from "./worker-topology.ts";

const ENV_KEYS = [
	"PORT",
	"WORKER_ID",
	"WORKER_OWNER_SCOPE",
	"WORKER_OWNER_EXCLUDE",
	"WORKER_OWNER_ROUTES",
	"WORKER_ASSIGNMENT_MODE",
	"WORKER_ASSIGNMENT_WORKERS",
	"WORKER_PRIMARY_ID",
	"WORKER_ROUTES",
	"CONTROL_PLANE_URL",
	"CONTROL_PLANE_TOKEN",
	"SQUARE_FAST_POLL_INTERVAL_MS",
	"SQUARE_FAST_POLL_ALLOW_50MS",
	"SQUARE_FAST_POLL_ALLOW_ZERO_MS",
	"SQUARE_FAST_POLL_SLOTS",
	"LINE_H2_LANES",
	"LINE_EFFECTIVE_H2_LANES",
	"LINE_H2_SEND_RESERVED_LANES",
	"LINE_RELAY_MODE",
	"LINE_RELAY_URL",
	"LINE_RELAY_TOKEN",
	"LANE_RELAY_TOKEN",
	"LINE_H2_POLL_EXPLORE_INTERVAL_MS",
	"LINE_H2_POLL_CALIBRATION_SAMPLES",
	"LINE_H2_APPLICATION_HOT_CEILING_MS",
	"LINE_H2_APPLICATION_DISCARD_CEILING_MS",
	"LINE_H2_APPLICATION_SAMPLE_MAX_AGE_MS",
	"LINE_H2_LANE_MAX_AGE_MS",
	"LINE_H2_LANE_RECYCLE_GAP_MS",
	"LINE_H2_DEGRADED_REPAIR_GAP_MS",
	"LINE_H2_DEGRADED_REPAIR_MIN_SAMPLES",
] as const;
const original = new Map<string, string | undefined>();

function setTopologyEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
	for (const key of ENV_KEYS) {
		if (!original.has(key)) original.set(key, process.env[key]);
		const value = values[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

afterEach(() => {
	db.exec("DELETE FROM owner_worker_assignments");
	for (const key of ENV_KEYS) {
		const value = original.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	original.clear();
});

describe("worker topology", () => {
	test("parses explicit loopback owner routes", () => {
		const routes = parseWorkerOwnerRoutes("2=http://127.0.0.1:8792,5=http://localhost:8793");
		expect(routes.get(2)?.origin).toBe("http://127.0.0.1:8792");
		expect(routes.get(5)?.origin).toBe("http://localhost:8793");
		expect(() => parseWorkerOwnerRoutes("2=https://example.com")).toThrow("loopback");
		expect(() => parseWorkerOwnerRoutes("bad=http://127.0.0.1:8792")).toThrow("invalid owner id");
	});

	test("parses loopback worker routes without allowing duplicates or external hosts", () => {
		const routes = parseWorkerRoutes("shard-b=http://127.0.0.1:8792");
		expect(routes.get("shard-b")?.origin).toBe("http://127.0.0.1:8792");
		expect(() => parseWorkerRoutes("shard-b=https://example.com")).toThrow("loopback");
		expect(() => parseWorkerRoutes("bad id=http://127.0.0.1:8792")).toThrow("workerId");
	});

	test("accepts a primary only when exclude and routes match exactly", () => {
		setTopologyEnv({
			PORT: "8791",
			WORKER_ID: "primary",
			WORKER_OWNER_EXCLUDE: "2,5",
			WORKER_OWNER_ROUTES: "2=http://127.0.0.1:8792,5=http://127.0.0.1:8793",
			CONTROL_PLANE_TOKEN: "x".repeat(32),
		});
		expect(validateWorkerTopology().ownerRoutes.size).toBe(2);
		process.env.WORKER_OWNER_EXCLUDE = "2";
		expect(() => validateWorkerTopology()).toThrow("exactly match");
	});

	test("accepts a scoped shard only with a separate control-plane URL and token", () => {
		setTopologyEnv({
			PORT: "8792",
			WORKER_ID: "shard-b",
			WORKER_OWNER_SCOPE: "2",
			CONTROL_PLANE_URL: "http://127.0.0.1:8791",
			CONTROL_PLANE_TOKEN: "s".repeat(32),
		});
		expect(validateWorkerTopology().controlPlaneUrl?.port).toBe("8791");
		expect(shouldRunControlPlaneJobs()).toBe(false);
		delete process.env.CONTROL_PLANE_URL;
		expect(() => validateWorkerTopology()).toThrow("requires CONTROL_PLANE_URL");
	});

	test("global maintenance stays on standalone/control-plane workers", () => {
		setTopologyEnv({});
		expect(shouldRunControlPlaneJobs()).toBe(true);
		process.env.WORKER_OWNER_EXCLUDE = "2";
		process.env.WORKER_OWNER_ROUTES = "2=http://127.0.0.1:8792";
		expect(shouldRunControlPlaneJobs()).toBe(true);
	});

	test("fails closed on an overlapping or self-referential split", () => {
		setTopologyEnv({
			PORT: "8792",
			WORKER_ID: "shard-b",
			WORKER_OWNER_SCOPE: "2",
			WORKER_OWNER_EXCLUDE: "5",
			CONTROL_PLANE_URL: "http://127.0.0.1:8791",
			CONTROL_PLANE_TOKEN: "s".repeat(32),
		});
		expect(() => validateWorkerTopology()).toThrow("อย่างใดอย่างหนึ่ง");

		setTopologyEnv({
			PORT: "8791",
			WORKER_ID: "primary",
			WORKER_OWNER_EXCLUDE: "2",
			WORKER_OWNER_ROUTES: "2=http://127.0.0.1:8791",
			CONTROL_PLANE_URL: undefined,
			CONTROL_PLANE_TOKEN: "x".repeat(32),
		});
		expect(() => validateWorkerTopology()).toThrow("own PORT");
	});

	test("an atomic runtime file overrides stale root-owned scope values for primary and shard", () => {
		const runtimeFile = JSON.stringify({
			version: 1,
			primary: { workerId: "primary", port: 8791 },
			shards: [{ workerId: "shard-b", port: 8792, ownerIds: [4], fastPollIntervalMs: 50 }],
			controlPlaneToken: "t".repeat(32),
		});
		setTopologyEnv({ PORT: "8791", WORKER_OWNER_SCOPE: "2" });
		expect(applyRuntimeTopologyFile(runtimeFile)).toBe(true);
		expect(process.env.WORKER_OWNER_SCOPE).toBeUndefined();
		expect(process.env.WORKER_OWNER_EXCLUDE).toBe("4");
		expect(process.env.WORKER_OWNER_ROUTES).toBe("4=http://127.0.0.1:8792");
		expect(process.env.SQUARE_FAST_POLL_INTERVAL_MS).toBe("100");

		setTopologyEnv({ PORT: "8792", WORKER_OWNER_SCOPE: "2" });
		expect(applyRuntimeTopologyFile(runtimeFile)).toBe(true);
		expect(process.env.WORKER_OWNER_SCOPE).toBe("4");
		expect(process.env.WORKER_OWNER_EXCLUDE).toBeUndefined();
		expect(process.env.CONTROL_PLANE_URL).toBe("http://127.0.0.1:8791");
		expect(process.env.SQUARE_FAST_POLL_INTERVAL_MS).toBe("50");
		expect(process.env.SQUARE_FAST_POLL_ALLOW_50MS).toBe("1");
	});

	test("runtime topology can opt an isolated shard into zero-delay polling", () => {
		const runtimeFile = JSON.stringify({
			version: 1,
			primary: { workerId: "primary", port: 8791 },
			shards: [
				{
					workerId: "shard-b",
					port: 8792,
					ownerIds: [4],
					fastPollIntervalMs: 0,
					h2Lanes: 12,
					sendReservedLanes: 4,
					fastPollSlots: 8,
				},
			],
			controlPlaneToken: "t".repeat(32),
		});
		setTopologyEnv({ PORT: "8792" });
		expect(applyRuntimeTopologyFile(runtimeFile)).toBe(true);
		expect(process.env.SQUARE_FAST_POLL_INTERVAL_MS).toBe("0");
		expect(process.env.SQUARE_FAST_POLL_ALLOW_ZERO_MS).toBe("1");
		expect(process.env.SQUARE_FAST_POLL_ALLOW_50MS).toBeUndefined();
		expect(process.env.LINE_H2_LANES).toBe("12");
		expect(process.env.LINE_H2_SEND_RESERVED_LANES).toBe("4");
		expect(process.env.SQUARE_FAST_POLL_SLOTS).toBe("8");
	});

	test("runtime topology can give primary and shard independent zero-delay capacity", () => {
		const runtimeFile = JSON.stringify({
			version: 1,
			primary: {
				workerId: "primary",
				port: 8791,
				fastPollIntervalMs: 0,
				h2Lanes: 12,
				sendReservedLanes: 4,
				fastPollSlots: 8,
			},
			shards: [
				{
					workerId: "shard-b",
					port: 8792,
					ownerIds: [4],
					fastPollIntervalMs: 0,
					h2Lanes: 8,
					sendReservedLanes: 4,
					fastPollSlots: 4,
				},
			],
			controlPlaneToken: "t".repeat(32),
		});
		setTopologyEnv({ PORT: "8791" });
		expect(applyRuntimeTopologyFile(runtimeFile)).toBe(true);
		expect(process.env.SQUARE_FAST_POLL_INTERVAL_MS).toBe("0");
		expect(process.env.SQUARE_FAST_POLL_ALLOW_ZERO_MS).toBe("1");
		expect(process.env.SQUARE_FAST_POLL_SLOTS).toBe("8");

		setTopologyEnv({ PORT: "8792" });
		expect(applyRuntimeTopologyFile(runtimeFile)).toBe(true);
		expect(process.env.SQUARE_FAST_POLL_SLOTS).toBe("4");
	});

	test("runtime topology applies fastest-first tuning and clears legacy ceilings", () => {
		const tuning = {
			fastPollIntervalMs: 0,
			h2Lanes: 16,
			sendReservedLanes: 4,
			fastPollSlots: 8,
			applicationSampleMaxAgeMs: 30_000,
			laneMaxAgeMs: 20 * 60_000,
			laneRecycleGapMs: 60_000,
		};
		const runtimeFile = JSON.stringify({
			version: 1,
			primary: { workerId: "primary", port: 8791, ...tuning },
			shards: [{ workerId: "shard-b", port: 8792, ownerIds: [4], ...tuning }],
			controlPlaneToken: "t".repeat(32),
		});
		setTopologyEnv({
			PORT: "8791",
			LINE_H2_APPLICATION_HOT_CEILING_MS: "20",
			LINE_H2_APPLICATION_DISCARD_CEILING_MS: "23",
			LINE_H2_DEGRADED_REPAIR_GAP_MS: "5000",
			LINE_H2_DEGRADED_REPAIR_MIN_SAMPLES: "1",
		});
		expect(applyRuntimeTopologyFile(runtimeFile)).toBe(true);
		expect(process.env.LINE_H2_LANES).toBe("16");
		expect(process.env.LINE_H2_APPLICATION_HOT_CEILING_MS).toBeUndefined();
		expect(process.env.LINE_H2_APPLICATION_DISCARD_CEILING_MS).toBeUndefined();
		expect(process.env.LINE_H2_DEGRADED_REPAIR_GAP_MS).toBeUndefined();
		expect(process.env.LINE_H2_DEGRADED_REPAIR_MIN_SAMPLES).toBeUndefined();
	});

	test("balanced-sticky topology gives primary a relay fallback and pins shard traffic to the relay", () => {
		const runtimeFile = JSON.stringify({
			version: 1,
			assignmentMode: "balanced-sticky",
			relayReportToken: "p".repeat(32),
			primary: {
				workerId: "primary",
				port: 8791,
				fastPollIntervalMs: 0,
				h2Lanes: 16,
				laneSource: "local",
				relayLanes: 32,
				relayUrl: "http://10.90.0.2:8795/dispatch",
				relayToken: "r".repeat(32),
				sendReservedLanes: 4,
				fastPollSlots: 8,
			},
			shards: [
				{
					workerId: "shard-b",
					port: 8792,
					fastPollIntervalMs: 0,
					h2Lanes: 0,
					laneSource: "relay",
					relayLanes: 32,
					relayUrl: "http://10.90.0.2:8795/dispatch",
					relayToken: "r".repeat(32),
					sendReservedLanes: 4,
					fastPollSlots: 8,
				},
			],
			controlPlaneToken: "t".repeat(32),
		});
		setTopologyEnv({ PORT: "8791" });
		expect(applyRuntimeTopologyFile(runtimeFile)).toBe(true);
		expect(process.env.WORKER_ASSIGNMENT_WORKERS).toBe("primary,shard-b");
		expect(process.env.LANE_RELAY_TOKEN).toBe("p".repeat(32));
		expect(process.env.WORKER_ROUTES).toBe("shard-b=http://127.0.0.1:8792");
		expect(process.env.LINE_RELAY_MODE).toBeUndefined();
		expect(process.env.LINE_RELAY_URL).toBe("http://10.90.0.2:8795/dispatch");
		expect(process.env.LINE_RELAY_TOKEN).toBe("r".repeat(32));
		expect(validateWorkerTopology().assignmentMode).toBe("balanced-sticky");

		setTopologyEnv({ PORT: "8792" });
		expect(applyRuntimeTopologyFile(runtimeFile)).toBe(true);
		expect(process.env.WORKER_ROUTES).toBeUndefined();
		expect(process.env.LINE_H2_LANES).toBe("0");
		expect(process.env.LINE_EFFECTIVE_H2_LANES).toBe("32");
		expect(process.env.LINE_RELAY_MODE).toBe("always");
		expect(validateWorkerTopology().controlPlaneUrl?.port).toBe("8791");
	});

	test("refuses a sticky assignment that names a removed worker", () => {
		const runtimeFile = JSON.stringify({
			version: 1,
			assignmentMode: "balanced-sticky",
			relayReportToken: "p".repeat(32),
			primary: { workerId: "primary", port: 8791 },
			shards: [{ workerId: "shard-b", port: 8792 }],
			controlPlaneToken: "t".repeat(32),
		});
		db.query("INSERT INTO owner_worker_assignments (owner_user_id, worker_id, assigned_at) VALUES (?, ?, ?)").run(
			991_991,
			"removed-worker",
			Date.now(),
		);
		setTopologyEnv({ PORT: "8791" });
		expect(() => {
			applyRuntimeTopologyFile(runtimeFile);
			validateWorkerTopology();
		}).toThrow("assigned to unknown worker");
	});

	test("runtime topology fails closed on duplicate owners, ports, and ambiguous sub-50ms polling", () => {
		setTopologyEnv({ PORT: "8791" });
		const base = {
			version: 1,
			primary: { workerId: "primary", port: 8791 },
			controlPlaneToken: "t".repeat(32),
		};
		expect(() => applyRuntimeTopologyFile(JSON.stringify({ ...base, shards: [{ workerId: "a", port: 8791, ownerIds: [4] }] }))).toThrow(
			"port 8791",
		);
		expect(() =>
			applyRuntimeTopologyFile(
				JSON.stringify({
					...base,
					shards: [
						{ workerId: "a", port: 8792, ownerIds: [4] },
						{ workerId: "b", port: 8793, ownerIds: [4] },
					],
				}),
			),
		).toThrow("owner 4");
		expect(() =>
			applyRuntimeTopologyFile(JSON.stringify({ ...base, shards: [{ workerId: "a", port: 8792, ownerIds: [4], fastPollIntervalMs: 49 }] })),
		).toThrow("zero-delay or at least 50ms");
		expect(() =>
			applyRuntimeTopologyFile(JSON.stringify({ ...base, shards: [{ workerId: "a", port: 8792, ownerIds: [4], fastPollIntervalMs: -1 }] })),
		).toThrow("non-negative integer");
		expect(() =>
			applyRuntimeTopologyFile(JSON.stringify({ ...base, shards: [{ workerId: "a", port: 8792, ownerIds: [4], fastPollIntervalMs: 0 }] })),
		).toThrow("zero-delay requires");
		expect(() =>
			applyRuntimeTopologyFile(
				JSON.stringify({
					...base,
					shards: [
						{
							workerId: "a",
							port: 8792,
							ownerIds: [4],
							fastPollIntervalMs: 0,
							h2Lanes: 8,
							sendReservedLanes: 4,
							fastPollSlots: 5,
						},
					],
				}),
			),
		).toThrow("cannot exceed");
	});
});
