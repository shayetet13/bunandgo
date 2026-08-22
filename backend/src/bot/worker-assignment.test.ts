import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../db/sqlite.ts";
import { assignedWorkerForOwner, ensureOwnerWorkerAssignment, parseAssignmentWorkers } from "./worker-assignment.ts";
import { inWorkerScope } from "./worker-scope.ts";

const savedEnv = new Map<string, string | undefined>();
const ENV_KEYS = ["WORKER_ASSIGNMENT_MODE", "WORKER_ASSIGNMENT_WORKERS", "WORKER_PRIMARY_ID", "WORKER_ID"] as const;

beforeEach(() => {
	for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
	process.env.WORKER_ASSIGNMENT_MODE = "balanced-sticky";
	process.env.WORKER_ASSIGNMENT_WORKERS = "primary,shard-b";
	process.env.WORKER_PRIMARY_ID = "primary";
	process.env.WORKER_ID = "primary";
	db.exec("DELETE FROM owner_worker_assignments");
});

afterEach(() => {
	db.exec("DELETE FROM owner_worker_assignments");
	for (const key of ENV_KEYS) {
		const value = savedEnv.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	savedEnv.clear();
});

describe("balanced sticky worker assignment", () => {
	test("allocates new owners evenly with a deterministic primary-first tie break", () => {
		expect(ensureOwnerWorkerAssignment(1)).toBe("primary");
		expect(ensureOwnerWorkerAssignment(2)).toBe("shard-b");
		expect(ensureOwnerWorkerAssignment(3)).toBe("primary");
		expect(ensureOwnerWorkerAssignment(4)).toBe("shard-b");
	});

	test("keeps a 100-owner fleet exactly balanced", () => {
		const counts = new Map<string, number>();
		for (let ownerId = 1; ownerId <= 100; ownerId++) {
			const worker = ensureOwnerWorkerAssignment(ownerId);
			counts.set(worker, (counts.get(worker) ?? 0) + 1);
		}
		expect(counts).toEqual(
			new Map([
				["primary", 50],
				["shard-b", 50],
			]),
		);
	});

	test("never moves an existing owner when more owners are added", () => {
		expect(ensureOwnerWorkerAssignment(11)).toBe("primary");
		ensureOwnerWorkerAssignment(12);
		ensureOwnerWorkerAssignment(13);
		expect(ensureOwnerWorkerAssignment(11)).toBe("primary");
		expect(assignedWorkerForOwner(11)).toBe("primary");
	});

	test("scope is exclusive and sends an unassigned owner through primary", () => {
		expect(inWorkerScope(99)).toBe(true);
		expect(ensureOwnerWorkerAssignment(1)).toBe("primary");
		expect(ensureOwnerWorkerAssignment(2)).toBe("shard-b");
		expect(inWorkerScope(1)).toBe(true);
		expect(inWorkerScope(2)).toBe(false);
		process.env.WORKER_ID = "shard-b";
		expect(inWorkerScope(1)).toBe(false);
		expect(inWorkerScope(2)).toBe(true);
		expect(inWorkerScope(99)).toBe(false);
	});

	test("rejects malformed worker sets and owner ids", () => {
		expect(() => parseAssignmentWorkers("primary")).toThrow("at least two");
		expect(() => parseAssignmentWorkers("primary,primary")).toThrow("duplicate");
		expect(() => ensureOwnerWorkerAssignment(0)).toThrow("invalid owner id");
	});
});
