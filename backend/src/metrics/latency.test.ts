import { describe, expect, test } from "bun:test";
import { sumLatencyBreakdown, summarizeLatencyGuardrails } from "./latency.ts";

describe("sumLatencyBreakdown", () => {
	test("adds every exclusive phase exactly once", () => {
		const totals = sumLatencyBreakdown({
			lineMs: 20.7,
			decryptMs: 0.01,
			matchMs: 0.01,
			limiterMs: 0.01,
			routingMs: 0.1,
			protocolPrepMs: 0.41,
			relayEncodeMs: 0.01,
			goPrepMs: 0.001,
			relayAndParseMs: 0.18,
		});

		expect(totals.codeMs).toBeCloseTo(0.731, 9);
		expect(totals.totalMs).toBeCloseTo(21.431, 9);
	});
});

test("latency guardrails expose every agreed escalation band", () => {
	const summary = summarizeLatencyGuardrails([20, 40, 51, 61, 81, 91, 101]);
	expect(summary.targetRate).toBeCloseTo((2 / 7) * 100);
	expect(summary.over50).toBe(5);
	expect(summary.over60).toBe(4);
	expect(summary.over80).toBe(3);
	expect(summary.over90).toBe(2);
	expect(summary.over100).toBe(1);
	expect(summary.level).toBe("critical");
});
