import { describe, expect, test } from "bun:test";
import { rttToneClass } from "../lib/lane-tone.ts";

describe("network speed panel RTT tone", () => {
	test("shows an eligible, application-measured lane as go", () => {
		expect(rttToneClass(true, true)).toBe("chip--go");
	});

	test("shows a measured but ineligible lane as bad", () => {
		expect(rttToneClass(true, false)).toBe("chip--bad");
	});

	test("shows a lane with no real traffic yet as idle, regardless of eligibility", () => {
		// A relay box can sit fully idle by design (overflow-only routing) —
		// its PING alone must never be colored the same as a lane proven fast
		// under real send/poll traffic.
		expect(rttToneClass(false, false)).toBe("chip--idle");
		expect(rttToneClass(false, true)).toBe("chip--idle");
	});
});
