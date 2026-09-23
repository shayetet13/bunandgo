import { describe, expect, test } from "bun:test";
import { currentPrewarmScope, runInPrewarmScope } from "./prewarm-scope.ts";

describe("prewarm scope", () => {
	test("is invisible before and after the callback", async () => {
		expect(currentPrewarmScope()).toBeUndefined();
		await runInPrewarmScope(async () => {
			expect(currentPrewarmScope()).toBeDefined();
		});
		expect(currentPrewarmScope()).toBeUndefined();
	});

	test("follows awaits inside the callback", async () => {
		await runInPrewarmScope(async () => {
			await Promise.resolve();
			await new Promise((resolve) => setTimeout(resolve, 1));
			expect(currentPrewarmScope()).toBeDefined();
		});
	});

	/**
	 * The regression this scope exists for. Prewarm used to be a counter on
	 * the client, so it was on for a span of *time* rather than for a span of
	 * *call stack*: every real request that happened to be in flight while a
	 * warm-up ran was answered from RAM instead of by LINE. A poller's
	 * `fetchSquareChatEvents` got a `sendMessage` ACK, and a genuine automatic
	 * reply was reported as sent without ever reaching LINE.
	 */
	test("does not leak into concurrent work started outside it", async () => {
		const observed: Array<boolean> = [];
		const realTraffic = (async () => {
			for (let i = 0; i < 5; i++) {
				await new Promise((resolve) => setTimeout(resolve, 1));
				observed.push(currentPrewarmScope() !== undefined);
			}
		})();

		await runInPrewarmScope(async () => {
			for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 1));
		});
		await realTraffic;

		expect(observed).toHaveLength(5);
		expect(observed.every((sawScope) => sawScope === false)).toBe(true);
	});

	test("keeps two concurrent prewarms on separate reqseq counters", async () => {
		const take = (): number => {
			const scope = currentPrewarmScope()!;
			const seq = scope.reqseqs.talk ?? 0;
			scope.reqseqs.talk = seq + 1;
			return seq;
		};
		const run = async (): Promise<number[]> =>
			runInPrewarmScope(async () => {
				const seqs: number[] = [];
				for (let i = 0; i < 3; i++) {
					await new Promise((resolve) => setTimeout(resolve, 1));
					seqs.push(take());
				}
				return seqs;
			});

		const [first, second] = await Promise.all([run(), run()]);
		expect(first).toEqual([0, 1, 2]);
		expect(second).toEqual([0, 1, 2]);
	});

	test("a nested call reuses the outer scope rather than resetting counters", async () => {
		await runInPrewarmScope(async () => {
			const outer = currentPrewarmScope();
			outer!.reqseqs.talk = 7;
			await runInPrewarmScope(async () => {
				expect(currentPrewarmScope()).toBe(outer!);
				expect(currentPrewarmScope()!.reqseqs.talk).toBe(7);
			});
		});
	});
});
