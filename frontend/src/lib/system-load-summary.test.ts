import { describe, expect, test } from "bun:test";
import { summarizeSystemLoad } from "./system-load-summary.ts";
import type { SystemLoadStatus } from "./types.ts";

function load(capacityPercent: number, exceeded = false): SystemLoadStatus {
	return {
		cpuPercent: 40,
		memoryPercent: 30,
		eventLoopLagMs: 5,
		capacityPercent,
		exceeded,
		exceededResources: exceeded ? ["cpu"] : [],
		limits: { cpuPercent: 80, memoryPercent: 80, eventLoopLagMs: 100 },
		sampledAt: 1,
	};
}

describe("summarizeSystemLoad", () => {
	test("shows how much of the configured limit is being used", () => {
		expect(summarizeSystemLoad(load(50))).toMatchObject({ label: "โหลดระบบ 50%", tone: "go" });
	});

	test("warns as load approaches the limit", () => {
		expect(summarizeSystemLoad(load(85))).toMatchObject({ label: "โหลดระบบ 85%", tone: "warn" });
	});

	test("marks a breached limit as bad", () => {
		const summary = summarizeSystemLoad(load(112, true));
		expect(summary).toMatchObject({ label: "โหลดระบบ 112%", tone: "bad" });
		expect(summary.detail).toContain("เกินขีดจำกัด");
	});

	test("does not invent a healthy percentage before metrics arrive", () => {
		expect(summarizeSystemLoad()).toMatchObject({ label: "กำลังตรวจโหลด...", tone: "idle" });
	});
});
