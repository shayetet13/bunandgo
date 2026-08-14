import { describe, expect, test } from "bun:test";
import { bangkokInputToEpochMs, epochMsToBangkokInput, formatBangkokDateTime } from "./bangkok-time.ts";

describe("bangkokInputToEpochMs", () => {
	test("12:00 Bangkok (minute precision) is 05:00 UTC (UTC+7)", () => {
		const epochMs = bangkokInputToEpochMs("2026-08-07T12:00");
		expect(epochMs).toBe(Date.UTC(2026, 7, 7, 5, 0, 0));
	});

	test("resolves 14:00:00.000 Bangkok to the exact millisecond — no seconds/ms left ambiguous", () => {
		const epochMs = bangkokInputToEpochMs("2026-08-07T14:00:00.000");
		expect(epochMs).toBe(Date.UTC(2026, 7, 7, 7, 0, 0, 0));
	});

	test("keeps seconds and milliseconds precision", () => {
		const epochMs = bangkokInputToEpochMs("2026-08-07T13:59:59.750");
		expect(epochMs).toBe(Date.UTC(2026, 7, 7, 6, 59, 59, 750));
	});

	test("accepts seconds without milliseconds", () => {
		const epochMs = bangkokInputToEpochMs("2026-08-07T14:00:05");
		expect(epochMs).toBe(Date.UTC(2026, 7, 7, 7, 0, 5, 0));
	});

	test("rejects a malformed value instead of guessing", () => {
		expect(bangkokInputToEpochMs("not-a-date")).toBeUndefined();
	});
});

describe("epochMsToBangkokInput", () => {
	test("round-trips through bangkokInputToEpochMs at millisecond precision", () => {
		const input = "2026-12-31T23:45:59.001";
		const epochMs = bangkokInputToEpochMs(input)!;
		expect(epochMsToBangkokInput(epochMs)).toBe(input);
	});

	test("always emits seconds and milliseconds, even for a minute-precision instant", () => {
		const epochMs = bangkokInputToEpochMs("2026-08-07T14:00")!;
		expect(epochMsToBangkokInput(epochMs)).toBe("2026-08-07T14:00:00.000");
	});
});

describe("formatBangkokDateTime", () => {
	test("includes the millisecond component", () => {
		const epochMs = bangkokInputToEpochMs("2026-08-07T14:00:00.250")!;
		expect(formatBangkokDateTime(epochMs)).toEndWith(".250");
	});
});
