import { describe, expect, test } from "bun:test";
import type { SquareMessage, TalkMessage } from "../linejs-core/client/mod.ts";
import { inboundDelayMs, isSlowInbound } from "./inbound-delay.ts";

function talk(createdTime: unknown): TalkMessage {
	return { raw: { createdTime } } as unknown as TalkMessage;
}

function square(createdTime: unknown): SquareMessage {
	return { raw: { message: { createdTime } } } as unknown as SquareMessage;
}

const NOW = 1_800_000_000_000;

describe("inboundDelayMs", () => {
	test("measures the gap between LINE's stamp and our receipt for talk", () => {
		expect(inboundDelayMs("talk", talk(NOW - 120), NOW)).toBe(120);
	});

	test("reads the timestamp from the nested square payload", () => {
		expect(inboundDelayMs("square", square(NOW - 85), NOW)).toBe(85);
	});

	test("accepts a bigint timestamp from the other decoder path", () => {
		expect(inboundDelayMs("square", square(BigInt(NOW - 200)), NOW)).toBe(200);
	});

	test("reports a negative gap rather than hiding clock skew behind zero", () => {
		// Our clock running ahead of LINE's is a real condition worth seeing;
		// clamping it to 0 would disguise a misconfigured server as healthy.
		expect(inboundDelayMs("talk", talk(NOW + 50), NOW)).toBe(-50);
	});

	test("returns undefined when the message carries no usable timestamp", () => {
		expect(inboundDelayMs("talk", talk(undefined), NOW)).toBeUndefined();
		expect(inboundDelayMs("talk", talk(0), NOW)).toBeUndefined();
		expect(inboundDelayMs("talk", talk("not-a-time"), NOW)).toBeUndefined();
		expect(inboundDelayMs("square", square(Number.NaN), NOW)).toBeUndefined();
	});
});

describe("isSlowInbound", () => {
	test("ignores an unmeasurable delay", () => {
		expect(isSlowInbound(undefined)).toBe(false);
	});

	test("does not flag a delay within the threshold", () => {
		expect(isSlowInbound(10)).toBe(false);
	});

	test("flags a delay past the threshold", () => {
		expect(isSlowInbound(10_000)).toBe(true);
	});
});
