import { describe, expect, test } from "bun:test";
import { SessionAttemptGate } from "./session-attempt.ts";

describe("SessionAttemptGate", () => {
	test("allows only one active login attempt", () => {
		const gate = new SessionAttemptGate();
		const first = gate.begin();

		expect(first).toBeDefined();
		expect(gate.begin()).toBeUndefined();
		expect(gate.isCurrent(first!)).toBe(true);
	});

	test("invalidates an old attempt before a restart can begin", () => {
		const gate = new SessionAttemptGate();
		const oldGeneration = gate.begin()!;

		gate.invalidate();
		const newGeneration = gate.begin()!;

		expect(gate.isCurrent(oldGeneration)).toBe(false);
		expect(gate.isCurrent(newGeneration)).toBe(true);
	});

	test("an old cleanup cannot clear a newer attempt", () => {
		const gate = new SessionAttemptGate();
		const oldGeneration = gate.begin()!;
		gate.invalidate();
		const newGeneration = gate.begin()!;

		gate.finish(oldGeneration);

		expect(gate.isCurrent(newGeneration)).toBe(true);
	});
});
