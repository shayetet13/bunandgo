import { describe, expect, test } from "bun:test";
import { clearAlertDedupe, shouldSendAlert } from "./alerts.ts";

const MINUTE = 60 * 1000;

describe("alert dedupe", () => {
	test("sends the first alert for a key", () => {
		const seen = new Map<string, number>();
		expect(shouldSendAlert("1:offline", 0, seen)).toBe(true);
	});

	test("suppresses a repeat inside the window", () => {
		const seen = new Map<string, number>();
		shouldSendAlert("1:offline", 0, seen);
		// A bot stuck in the QR retry loop reaches this path every few seconds.
		expect(shouldSendAlert("1:offline", 5 * MINUTE, seen)).toBe(false);
	});

	test("sends again once the window has passed", () => {
		const seen = new Map<string, number>();
		shouldSendAlert("1:offline", 0, seen);
		expect(shouldSendAlert("1:offline", 11 * MINUTE, seen)).toBe(true);
	});

	test("tracks each bot separately", () => {
		const seen = new Map<string, number>();
		shouldSendAlert("1:offline", 0, seen);
		// One bot going down must not silence another's alert.
		expect(shouldSendAlert("2:offline", 0, seen)).toBe(true);
	});

	test("tracks each kind separately", () => {
		const seen = new Map<string, number>();
		shouldSendAlert("1:offline", 0, seen);
		expect(shouldSendAlert("1:recovered", 0, seen)).toBe(true);
	});

	test("clearing re-arms a key immediately", () => {
		const seen = new Map<string, number>();
		shouldSendAlert("1:offline", 0, seen);
		clearAlertDedupe("1:offline", seen);
		// Recovery clears the outage key so the *next* outage is reported even
		// if it lands inside what would still be the dedupe window.
		expect(shouldSendAlert("1:offline", MINUTE, seen)).toBe(true);
	});
});
