import { afterEach, describe, expect, test } from "bun:test";
import { inWorkerScope } from "./worker-scope.ts";

const ENV_KEYS = ["WORKER_OWNER_SCOPE", "WORKER_OWNER_EXCLUDE"] as const;
const prior: Record<string, string | undefined> = {};

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
	for (const key of ENV_KEYS) {
		if (!(key in prior)) prior[key] = process.env[key];
		const value = values[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (prior[key] === undefined) delete process.env[key];
		else process.env[key] = prior[key];
		delete prior[key];
	}
});

describe("inWorkerScope", () => {
	test("unset (default): every owner, including null, is in scope", () => {
		setEnv({});
		expect(inWorkerScope(1)).toBe(true);
		expect(inWorkerScope(999)).toBe(true);
		expect(inWorkerScope(null)).toBe(true);
	});

	test("WORKER_OWNER_SCOPE: only the listed owners are in scope, null owner excluded", () => {
		setEnv({ WORKER_OWNER_SCOPE: "2, 5" });
		expect(inWorkerScope(2)).toBe(true);
		expect(inWorkerScope(5)).toBe(true);
		expect(inWorkerScope(1)).toBe(false);
		expect(inWorkerScope(null)).toBe(false);
	});

	test("WORKER_OWNER_EXCLUDE: every owner except the listed ones, null owner included", () => {
		setEnv({ WORKER_OWNER_EXCLUDE: "2" });
		expect(inWorkerScope(2)).toBe(false);
		expect(inWorkerScope(1)).toBe(true);
		expect(inWorkerScope(9)).toBe(true);
		expect(inWorkerScope(null)).toBe(true);
	});

	test("setting both env vars at once throws instead of picking one silently", () => {
		setEnv({ WORKER_OWNER_SCOPE: "1", WORKER_OWNER_EXCLUDE: "2" });
		expect(() => inWorkerScope(1)).toThrow();
	});

	test("malformed owner ids fail closed instead of being silently ignored", () => {
		setEnv({ WORKER_OWNER_SCOPE: "2,bad" });
		expect(() => inWorkerScope(2)).toThrow("invalid owner id");
		setEnv({ WORKER_OWNER_EXCLUDE: "1e2" });
		expect(() => inWorkerScope(100)).toThrow("invalid owner id");
	});
});
