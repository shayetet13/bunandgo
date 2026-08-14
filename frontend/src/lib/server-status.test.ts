import { describe, expect, test } from "bun:test";
import { summarizeServer } from "./server-status.ts";
import type { ServerStatus } from "./types.ts";

function server(overrides: Partial<ServerStatus> = {}): ServerStatus {
	return {
		id: "server1",
		label: "Server 1",
		role: "AWS Gateway",
		reachable: true,
		serviceHealthy: true,
		load: { cpuPercent: 20, memoryPercent: 30, capacityPercent: 38, exceeded: false, sampledAt: 1 },
		...overrides,
	};
}

describe("summarizeServer", () => {
	test("marks an unreachable server red", () => {
		expect(summarizeServer(server({ reachable: false }))).toMatchObject({ label: "ติดต่อไม่ได้", tone: "bad" });
	});

	test("marks a high but valid load orange", () => {
		expect(summarizeServer(server({ load: { cpuPercent: 70, memoryPercent: 60, capacityPercent: 85, exceeded: false, sampledAt: 1 } }))).toMatchObject({ tone: "warn" });
	});

	test("marks an exceeded load red", () => {
		expect(summarizeServer(server({ load: { cpuPercent: 90, memoryPercent: 60, capacityPercent: 113, exceeded: true, sampledAt: 1 } }))).toMatchObject({ tone: "bad" });
	});
});
