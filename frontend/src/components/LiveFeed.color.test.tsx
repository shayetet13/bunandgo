import { describe, expect, test } from "bun:test";
import { toneFor, BUDGET, sumLatencyBreakdown } from "../lib/live-feed-metrics.ts";

describe("breakdown colour thresholds", () => {
	test("a normal LINE round trip reads as good", () => {
		// The 23.8ms seen in production.
		expect(toneFor(23.8, BUDGET.line)).toBe("var(--signal-go)");
	});

	test("the same 23.8ms would read as bad for Go, which should round to zero", () => {
		// The point of per-metric budgets: identical numbers, opposite meanings.
		expect(toneFor(23.8, BUDGET.go)).toBe("var(--signal-bad)");
	});

	test("today's protocol figure reads as good", () => {
		expect(toneFor(2.45, BUDGET.protocol)).toBe("var(--signal-go)");
	});

	test("protocol degrading past its budget turns warn then bad", () => {
		expect(toneFor(6, BUDGET.protocol)).toBe("var(--signal-warn)");
		expect(toneFor(25, BUDGET.protocol)).toBe("var(--signal-bad)");
	});

	test("boundaries are inclusive of the better tone", () => {
		expect(toneFor(BUDGET.code[0], BUDGET.code)).toBe("var(--signal-go)");
		expect(toneFor(BUDGET.code[1], BUDGET.code)).toBe("var(--signal-warn)");
	});

	test("zero is always good", () => {
		for (const budget of Object.values(BUDGET)) {
			expect(toneFor(0, budget)).toBe("var(--signal-go)");
		}
	});
});

describe("latency phase sum", () => {
	test("does not add the CODE subtotal on top of its child phases", () => {
		const result = sumLatencyBreakdown({
			lineMs: 20.7,
			codeMs: 0.631,
			decryptMs: 0.01,
			matchMs: 0.01,
			limiterMs: 0.01,
			protocolPrepMs: 0.41,
			relayEncodeMs: 0.01,
			goPrepMs: 0.001,
			relayAndParseMs: 0.18,
			upstreamCalls: 1,
		});

		expect(result.codeMs).toBeCloseTo(0.631, 9);
		expect(result.totalMs).toBeCloseTo(21.331, 9);
	});
});
