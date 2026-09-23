import { describe, expect, test } from "bun:test";
import { advanceLoadAlertState, buildSystemLoadSnapshot, calculateCpuPercent, type LoadAlertState } from "./system-load.ts";

const limits = { cpuPercent: 80, memoryPercent: 80, eventLoopLagMs: 100 };

describe("system load metrics", () => {
	test("calculates host CPU usage from idle and total deltas", () => {
		expect(calculateCpuPercent({ idle: 1_000, total: 2_000 }, { idle: 1_250, total: 2_500 })).toBe(50);
	});

	test("reports capacity relative to the configured limit", () => {
		const snapshot = buildSystemLoadSnapshot(40, 20, 10, limits, 123);
		expect(snapshot).toMatchObject({ capacityPercent: 50, exceeded: false, exceededResources: [], sampledAt: 123 });
	});

	test("marks every resource that reaches its limit", () => {
		const snapshot = buildSystemLoadSnapshot(81, 80, 120, limits);
		expect(snapshot.exceeded).toBe(true);
		expect(snapshot.exceededResources).toEqual(["cpu", "memory", "eventLoop"]);
		expect(snapshot.capacityPercent).toBe(120);
	});
});

describe("system load alert policy", () => {
	test("requires sustained overload and sustained recovery", () => {
		const state: LoadAlertState = { active: false, overStreak: 0, recoveryStreak: 0 };
		let result = advanceLoadAlertState(state, true, 3, 2);
		expect(result.event).toBeUndefined();
		result = advanceLoadAlertState(result.state, true, 3, 2);
		expect(result.event).toBeUndefined();
		result = advanceLoadAlertState(result.state, true, 3, 2);
		expect(result.event).toBe("overload");
		result = advanceLoadAlertState(result.state, false, 3, 2);
		expect(result.event).toBeUndefined();
		result = advanceLoadAlertState(result.state, false, 3, 2);
		expect(result.event).toBe("recovered");
	});
});
