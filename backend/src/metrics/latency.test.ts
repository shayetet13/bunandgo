import { describe, expect, test } from "bun:test";
import { sumLatencyBreakdown } from "./latency.ts";

describe("sumLatencyBreakdown", () => {
	test("adds every exclusive phase exactly once", () => {
		const totals = sumLatencyBreakdown({
			lineMs: 20.7,
			decryptMs: 0.01,
			matchMs: 0.01,
			limiterMs: 0.01,
			routingMs: 0.10,
			protocolPrepMs: 0.41,
			relayEncodeMs: 0.01,
			goPrepMs: 0.001,
			relayAndParseMs: 0.18,
		});

		expect(totals.codeMs).toBeCloseTo(0.731, 9);
		expect(totals.totalMs).toBeCloseTo(21.431, 9);
	});
});
