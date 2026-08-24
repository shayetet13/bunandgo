import { beforeEach, describe, expect, test } from "bun:test";

const { listServerLoadSamples, pruneServerLoadSamples, recordServerLoadSample } = await import("./server-load-history.ts");
const { db } = await import("../db/sqlite.ts");

beforeEach(() => {
	db.exec("DELETE FROM server_load_samples");
});

describe("recordServerLoadSample / listServerLoadSamples", () => {
	test("round-trips a sample for each server", () => {
		const now = Date.now();
		recordServerLoadSample("server1", { cpuPercent: 12.5, memoryPercent: 40, capacityPercent: 50, sampledAt: now });
		recordServerLoadSample("server2", { cpuPercent: 33, memoryPercent: 55, capacityPercent: 68.75, eventLoopLagMs: 4.2, sampledAt: now });
		recordServerLoadSample("server3", { cpuPercent: 5, memoryPercent: 20, capacityPercent: 25, sampledAt: now });

		const samples = listServerLoadSamples(1, now + 1_000);
		expect(samples).toHaveLength(3);
		const byServer = new Map(samples.map((s) => [s.serverId, s]));
		expect(byServer.get("server1")?.cpuPercent).toBe(12.5);
		expect(byServer.get("server2")?.eventLoopLagMs).toBe(4.2);
		expect(byServer.get("server3")?.memoryPercent).toBe(20);
	});

	test("defaults eventLoopLagMs to null when omitted", () => {
		const now = Date.now();
		recordServerLoadSample("server1", { cpuPercent: 1, memoryPercent: 1, capacityPercent: 1, sampledAt: now });
		const [sample] = listServerLoadSamples(1, now + 1_000);
		expect(sample?.eventLoopLagMs).toBeNull();
	});

	test("excludes samples older than the requested window", () => {
		const now = Date.now();
		recordServerLoadSample("server2", { cpuPercent: 1, memoryPercent: 1, capacityPercent: 1, sampledAt: now - 2 * 3_600_000 });
		recordServerLoadSample("server2", { cpuPercent: 2, memoryPercent: 2, capacityPercent: 2, sampledAt: now - 30 * 60_000 });

		const samples = listServerLoadSamples(1, now);
		expect(samples).toHaveLength(1);
		expect(samples[0]?.cpuPercent).toBe(2);
	});

	test("orders results oldest first", () => {
		const now = Date.now();
		recordServerLoadSample("server1", { cpuPercent: 2, memoryPercent: 2, capacityPercent: 2, sampledAt: now - 1_000 });
		recordServerLoadSample("server1", { cpuPercent: 1, memoryPercent: 1, capacityPercent: 1, sampledAt: now - 5_000 });

		const samples = listServerLoadSamples(1, now + 1_000);
		expect(samples.map((s) => s.cpuPercent)).toEqual([1, 2]);
	});
});

describe("pruneServerLoadSamples", () => {
	test("deletes samples older than the retention window, keeps the rest", () => {
		const now = Date.now();
		const veryOld = now - 40 * 86_400_000;
		const recent = now - 1_000;
		recordServerLoadSample("server1", { cpuPercent: 1, memoryPercent: 1, capacityPercent: 1, sampledAt: veryOld });
		recordServerLoadSample("server1", { cpuPercent: 2, memoryPercent: 2, capacityPercent: 2, sampledAt: recent });

		pruneServerLoadSamples(now);

		const samples = listServerLoadSamples(24 * 60, now + 1_000);
		expect(samples).toHaveLength(1);
		expect(samples[0]?.cpuPercent).toBe(2);
	});
});
