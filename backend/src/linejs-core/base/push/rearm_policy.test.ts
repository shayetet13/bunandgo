import { describe, expect, test } from "bun:test";
import { SquareRearmPolicy } from "./rearm_policy.ts";

describe("SquareRearmPolicy", () => {
	test("arms the next fetch immediately when events arrived", () => {
		const policy = new SquareRearmPolicy();

		expect(policy.next(5)).toEqual({ rearm: true, delayMs: 0 });
	});

	test("keeps arming without delay while events keep arriving", () => {
		const policy = new SquareRearmPolicy();

		const decisions = [policy.next(1), policy.next(3), policy.next(2)];

		expect(decisions.every((d) => d.rearm && d.delayMs === 0)).toBe(true);
	});

	test("waits before re-arming after an empty answer", () => {
		const policy = new SquareRearmPolicy({ idleDelayMs: 500 });

		expect(policy.next(0)).toEqual({ rearm: true, delayMs: 500 });
	});

	test("keeps re-arming no matter how many empty answers arrive in a row", () => {
		const policy = new SquareRearmPolicy({ idleDelayMs: 500 });

		for (let i = 0; i < 50; i++) {
			expect(policy.next(0)).toEqual({ rearm: true, delayMs: 500 });
		}
	});

	test("goes back to zero delay the moment events resume after a run of empty answers", () => {
		const policy = new SquareRearmPolicy({ idleDelayMs: 500 });

		policy.next(0);
		policy.next(0);
		policy.next(0);

		expect(policy.next(4)).toEqual({ rearm: true, delayMs: 0 });
	});
});
