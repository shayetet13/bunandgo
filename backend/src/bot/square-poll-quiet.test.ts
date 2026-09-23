import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../db/sqlite.ts";
import {
	applySquarePollQuietMs,
	markSquareReplyDispatched,
	parseQuietMs,
	refreshSquarePollQuietConfig,
	resetSquarePollQuietState,
	squarePollQuietRemainingMs,
	squarePollQuietWindowMs,
} from "./square-poll-quiet.ts";

beforeEach(() => {
	db.prepare("DELETE FROM app_meta WHERE key = 'square.fast_poll.quiet_ms'").run();
	refreshSquarePollQuietConfig();
	resetSquarePollQuietState();
});

describe("parseQuietMs", () => {
	test("accepts an in-range integer, as a bare value or a { quietMs } body", () => {
		expect(parseQuietMs(0)).toBe(0);
		expect(parseQuietMs("15")).toBe(15);
		expect(parseQuietMs({ quietMs: 40 })).toBe(40);
	});

	test("rejects non-integers and out-of-range values", () => {
		expect(() => parseQuietMs("abc")).toThrow();
		expect(() => parseQuietMs(12.5)).toThrow();
		expect(() => parseQuietMs(-1)).toThrow();
		expect(() => parseQuietMs(41)).toThrow();
	});
});

describe("config persistence", () => {
	test("defaults to the 15ms production starting point with no row and no env override", () => {
		expect(squarePollQuietWindowMs()).toBe(15);
	});

	test("apply writes app_meta and updates the live view; refresh reads it back", () => {
		expect(applySquarePollQuietMs(18)).toBe(18);
		expect(squarePollQuietWindowMs()).toBe(18);
		expect(refreshSquarePollQuietConfig()).toBe(18);
	});

	test("clamps an aggressive applied value into range", () => {
		expect(applySquarePollQuietMs(999)).toBe(40);
	});

	test("a malformed app_meta row falls back to the default instead of throwing", () => {
		db.prepare("INSERT INTO app_meta (key, value) VALUES ('square.fast_poll.quiet_ms', 'not-a-number')").run();
		expect(refreshSquarePollQuietConfig()).toBe(15);
	});
});

describe("per-room quiet window", () => {
	test("is a no-op while the window is 0", () => {
		applySquarePollQuietMs(0);
		markSquareReplyDispatched("m-room", 1_000);
		expect(squarePollQuietRemainingMs("m-room", 1_000)).toBe(0);
	});

	test("holds a room for the window after a reply, then decays", () => {
		applySquarePollQuietMs(20);
		markSquareReplyDispatched("m-room", 1_000);
		expect(squarePollQuietRemainingMs("m-room", 1_000)).toBe(20);
		expect(squarePollQuietRemainingMs("m-room", 1_010)).toBe(10);
		expect(squarePollQuietRemainingMs("m-room", 1_020)).toBe(0);
		expect(squarePollQuietRemainingMs("m-room", 1_025)).toBe(0);
	});

	test("tracks rooms independently", () => {
		applySquarePollQuietMs(20);
		markSquareReplyDispatched("m-a", 1_000);
		markSquareReplyDispatched("m-b", 1_005);
		expect(squarePollQuietRemainingMs("m-a", 1_010)).toBe(10);
		expect(squarePollQuietRemainingMs("m-b", 1_010)).toBe(15);
		expect(squarePollQuietRemainingMs("m-unknown", 1_010)).toBe(0);
	});

	test("a later reply in the same room extends the window", () => {
		applySquarePollQuietMs(20);
		markSquareReplyDispatched("m-room", 1_000);
		markSquareReplyDispatched("m-room", 1_015);
		expect(squarePollQuietRemainingMs("m-room", 1_020)).toBe(15);
	});
});
