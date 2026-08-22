import { describe, expect, test } from "bun:test";
import { AsyncQueue } from "./async-queue.ts";

/** Resolves on a macrotask boundary, so queued work can't finish "by accident". */
function tick(ms = 0): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("AsyncQueue", () => {
	test("runs tasks strictly one at a time, in submission order", async () => {
		const queue = new AsyncQueue();
		const order: number[] = [];
		let active = 0;
		let maxActive = 0;

		async function task(id: number, delayMs: number): Promise<void> {
			active++;
			maxActive = Math.max(maxActive, active);
			await tick(delayMs);
			order.push(id);
			active--;
		}

		// Task 1 is the slowest; if the queue let 2 and 3 run alongside it,
		// they would finish first and `order` would come out wrong.
		const results = [queue.run(() => task(1, 30)), queue.run(() => task(2, 10)), queue.run(() => task(3, 5))];
		await Promise.all(results);

		expect(order).toEqual([1, 2, 3]);
		expect(maxActive).toBe(1);
	});

	test("this exact pattern serializes a read-modify-write race", async () => {
		// Mirrors connManager.ts: two callers read a shared token, do async
		// work, then write a new token back. Without the queue, both would
		// read the same starting value and the later write would win,
		// silently discarding whatever the other caller fetched.
		const queue = new AsyncQueue();
		let sharedToken = "start";
		const fetched: string[] = [];

		async function fetchAndAdvance(label: string): Promise<void> {
			await queue.run(async () => {
				const readAt = sharedToken;
				await tick(5);
				fetched.push(`${label} saw ${readAt}`);
				sharedToken = `${readAt}->${label}`;
			});
		}

		await Promise.all([fetchAndAdvance("push"), fetchAndAdvance("rearm")]);

		expect(fetched).toEqual(["push saw start", "rearm saw start->push"]);
		expect(sharedToken).toBe("start->push->rearm");
	});

	test("a failing task does not jam later ones", async () => {
		const queue = new AsyncQueue();
		const completed: string[] = [];

		const first = queue.run(async () => {
			throw new Error("boom");
		});
		const second = queue.run(async () => {
			completed.push("second");
		});

		await expect(first).rejects.toThrow("boom");
		await second;
		expect(completed).toEqual(["second"]);
	});

	test("propagates each task's own result to its own caller", async () => {
		const queue = new AsyncQueue();
		const a = queue.run(async () => 1);
		const b = queue.run(async () => "two");
		expect(await a).toBe(1);
		expect(await b).toBe("two");
	});
});
