import { describe, expect, test } from "bun:test";
import type { SquareEvent } from "../linejs-core/types/line_types.ts";
import {
	FastSquarePollSlotPool,
	resolveFastSquarePollIntervalMs,
	resolveFastSquarePollSlots,
	runFastSquarePoller,
	type FastSquareFetchResponse,
} from "./fast-square-poller.ts";

function event(id: number): SquareEvent {
	return { createdTime: id } as unknown as SquareEvent;
}

describe("fast Square poll interval configuration", () => {
	test("keeps the main worker default at 100ms", () => {
		expect(resolveFastSquarePollIntervalMs(undefined, undefined)).toBe(100);
		expect(resolveFastSquarePollIntervalMs("", undefined)).toBe(100);
	});

	test("does not activate a dormant 50ms value without the explicit gate", () => {
		expect(resolveFastSquarePollIntervalMs("50", undefined)).toBe(100);
		expect(resolveFastSquarePollIntervalMs("50", "0")).toBe(100);
		expect(resolveFastSquarePollIntervalMs("50", "true")).toBe(100);
	});

	test("allows 50ms only when an isolated shard opts in explicitly", () => {
		expect(resolveFastSquarePollIntervalMs("50", "1")).toBe(50);
		expect(resolveFastSquarePollIntervalMs("49", "1")).toBe(50);
		expect(resolveFastSquarePollIntervalMs("0", "1")).toBe(50);
	});

	test("allows zero-delay only behind its separate isolated-shard gate", () => {
		expect(resolveFastSquarePollIntervalMs("0", undefined, undefined)).toBe(100);
		expect(resolveFastSquarePollIntervalMs("0", "1", undefined)).toBe(50);
		expect(resolveFastSquarePollIntervalMs("0", undefined, "1")).toBe(0);
		expect(resolveFastSquarePollIntervalMs("-10", undefined, "1")).toBe(0);
		expect(resolveFastSquarePollIntervalMs("25", undefined, "1")).toBe(25);
	});

	test("the gate alone does not lower the default", () => {
		expect(resolveFastSquarePollIntervalMs(undefined, "1")).toBe(100);
		expect(resolveFastSquarePollIntervalMs("", "1")).toBe(100);
	});

	test("normalizes malformed and timer-overflowing values safely", () => {
		expect(resolveFastSquarePollIntervalMs("NaN", "1")).toBe(100);
		expect(resolveFastSquarePollIntervalMs("Infinity", "1")).toBe(100);
		expect(resolveFastSquarePollIntervalMs("50.1", "1")).toBe(51);
		expect(resolveFastSquarePollIntervalMs(String(Number.MAX_VALUE), "1")).toBe(2_147_483_647);
	});

	test("caps aggressive slots to the non-send H2 lane budget", () => {
		expect(resolveFastSquarePollSlots("8", "12", "4")).toBe(8);
		expect(resolveFastSquarePollSlots("99", "8", "4")).toBe(4);
		expect(resolveFastSquarePollSlots(undefined, "8", "4")).toBe(1);
		expect(resolveFastSquarePollSlots("NaN", "8", "4")).toBe(1);
	});

	test("keeps established fast slots instead of downgrading every bot", () => {
		const slots = new FastSquarePollSlotPool(2);
		expect(slots.acquire(129)).toBe(true);
		expect(slots.acquire(120)).toBe(true);
		expect(slots.acquire(129)).toBe(true);
		expect(slots.acquire(131)).toBe(false);
		expect(slots.size).toBe(2);
		expect(slots.release(120)).toBe(true);
		expect(slots.acquire(131)).toBe(true);
		expect(slots.has(129)).toBe(true);
		expect(slots.has(131)).toBe(true);
	});
});

describe("fast Square per-room poller", () => {
	test("drains startup history, advances the sync token, then delivers synchronously", async () => {
		const abort = new AbortController();
		const responses: FastSquareFetchResponse[] = [
			{ events: [event(1)], syncToken: "s1" },
			{ events: [], syncToken: "s2" },
			{ events: [event(2)], syncToken: "s3" },
		];
		const seenTokens: Array<string | undefined> = [];
		const delivered: number[] = [];

		await runFastSquarePoller({
			squareChatMid: "m-room",
			signal: abort.signal,
			intervalMs: 0,
			async fetchEvents(options) {
				seenTokens.push(options.syncToken);
				return responses.shift()!;
			},
			onEvent(received) {
				delivered.push(Number(received.createdTime));
				abort.abort();
			},
		});

		expect(seenTokens).toEqual([undefined, "s1", "s2"]);
		expect(delivered).toEqual([2]);
	});

	test("backs off after an error and resumes from the last good token", async () => {
		const abort = new AbortController();
		const seenTokens: Array<string | undefined> = [];
		const errors: number[] = [];
		let call = 0;

		await runFastSquarePoller({
			squareChatMid: "m-room",
			signal: abort.signal,
			intervalMs: 0,
			async fetchEvents(options) {
				seenTokens.push(options.syncToken);
				call++;
				if (call === 1) return { events: [], syncToken: "ready" };
				if (call === 2) throw new Error("temporary");
				return { events: [event(3)], syncToken: "next" };
			},
			onError(_error, failures) {
				errors.push(failures);
			},
			onEvent() {
				abort.abort();
			},
		});

		expect(seenTokens).toEqual([undefined, "ready", "ready"]);
		expect(errors).toEqual([1]);
	});

	test("a fetch that never resolves times out and backs off instead of blocking the room forever", async () => {
		const abort = new AbortController();
		const errors: string[] = [];
		let call = 0;

		await runFastSquarePoller({
			squareChatMid: "m-room",
			signal: abort.signal,
			intervalMs: 0,
			fetchTimeoutMs: 5,
			async fetchEvents(_options, signal) {
				call++;
				if (call === 1) return { events: [], syncToken: "ready" };
				if (call === 2) {
					return await new Promise<FastSquareFetchResponse>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
				}
				return { events: [event(9)], syncToken: "next" };
			},
			onError(error, failures) {
				errors.push(error instanceof Error ? error.message : String(error));
				expect(failures).toBe(1);
			},
			onEvent() {
				abort.abort();
			},
		});

		expect(call).toBe(3);
		expect(errors).toEqual(["fast-poll fetch timed out after 5ms"]);
	});

	test("can stagger a peer without issuing a request before its slot", async () => {
		const abort = new AbortController();
		let calls = 0;
		const running = runFastSquarePoller({
			squareChatMid: "m-room",
			signal: abort.signal,
			initialDelayMs: 50,
			async fetchEvents() {
				calls++;
				return { events: [], syncToken: "unused" };
			},
			onEvent() {},
		});

		await Bun.sleep(5);
		abort.abort();
		await running;
		expect(calls).toBe(0);
	});

	test("consults quietBeforeNextFetchMs only after a primed delivery, before the next fetch", async () => {
		const abort = new AbortController();
		const trace: string[] = [];
		const responses: FastSquareFetchResponse[] = [
			{ events: [], syncToken: "primed" },
			{ events: [event(1)], syncToken: "s1" },
			{ events: [event(2)], syncToken: "s2" },
		];

		await runFastSquarePoller({
			squareChatMid: "m-room",
			signal: abort.signal,
			intervalMs: 0,
			async fetchEvents() {
				trace.push("fetch");
				return responses.shift()!;
			},
			onEvent() {
				trace.push("deliver");
				if (responses.length === 0) abort.abort();
			},
			quietBeforeNextFetchMs() {
				trace.push("quiet?");
				return 0;
			},
		});

		// The drain fetch delivers nothing and is not followed by a quiet
		// check; each real delivery is, before the next fetch.
		expect(trace).toEqual(["fetch", "fetch", "deliver", "quiet?", "fetch", "deliver", "quiet?"]);
	});

	test("a quiet value larger than the interval delays the next fetch", async () => {
		const abort = new AbortController();
		const fetchAt: number[] = [];
		let quietOnce = 40;
		const responses: FastSquareFetchResponse[] = [
			{ events: [], syncToken: "primed" },
			{ events: [event(1)], syncToken: "s1" },
			{ events: [event(2)], syncToken: "s2" },
		];

		await runFastSquarePoller({
			squareChatMid: "m-room",
			signal: abort.signal,
			intervalMs: 0,
			async fetchEvents() {
				fetchAt.push(performance.now());
				return responses.shift()!;
			},
			onEvent() {
				if (responses.length === 0) abort.abort();
			},
			quietBeforeNextFetchMs() {
				const value = quietOnce;
				quietOnce = 0;
				return value;
			},
		});

		// Gap between the fetch after the first delivery and the next one.
		expect(fetchAt[2]! - fetchAt[1]!).toBeGreaterThanOrEqual(30);
	});
});
