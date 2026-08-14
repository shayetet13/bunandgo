import { describe, expect, test } from "bun:test";
import {
	ESCALATE_AFTER_FAILED_REFRESHES,
	planStallRecovery,
	SQUARE_STALL_MS,
	SQUARE_STALL_RECOVERY_COOLDOWN_MS,
	type StallInput,
} from "./square-stall-policy.ts";

const NOW = 1_000_000;

function input(overrides: Partial<StallInput> = {}): StallInput {
	return {
		now: NOW,
		lastSquareFetchAt: NOW - SQUARE_STALL_MS - 1_000,
		lastRefreshAt: undefined,
		hasConnection: true,
		failedRefreshes: 0,
		// Most cases below exercise the escalation past the cheap repair, so the
		// default is "already tried"; the re-arm step has its own tests.
		rearmTried: true,
		...overrides,
	};
}

describe("planStallRecovery", () => {
	test("says healthy while a fetch response is still recent", () => {
		expect(planStallRecovery(input({ lastSquareFetchAt: NOW - 100 })).action).toBe("healthy");
		expect(planStallRecovery(input({ lastSquareFetchAt: NOW - SQUARE_STALL_MS + 1 })).action).toBe("healthy");
	});

	test("asks for a refresh once the chain has been silent past the threshold", () => {
		const plan = planStallRecovery(input({ lastSquareFetchAt: NOW - SQUARE_STALL_MS }));
		expect(plan).toEqual({ action: "refresh", staleMs: SQUARE_STALL_MS, attempt: 1 });
	});

	// The chain stopping is the failure; tearing down the connection under it
	// is a guess. Try the thing that addresses the failure directly first.
	test("tries the cheap in-place re-arm before touching the connection", () => {
		const plan = planStallRecovery(input({ rearmTried: false }));
		expect(plan).toMatchObject({ action: "rearm" });
	});

	test("the re-arm is not held off by the refresh cooldown", () => {
		const plan = planStallRecovery(input({ rearmTried: false, lastRefreshAt: NOW - 1 }));
		expect(plan.action).toBe("rearm");
	});

	test("falls through to closing the connection once the re-arm has been tried", () => {
		expect(planStallRecovery(input({ rearmTried: true })).action).toBe("refresh");
	});

	// The bug: closing conns[0] when it is already gone does nothing, but the
	// old code armed the 15s cooldown anyway and called it a recovery.
	test("retries soon instead of arming a cooldown when there is no connection to close", () => {
		const plan = planStallRecovery(input({ hasConnection: false }));
		expect(plan.action).toBe("retry-soon");
	});

	test("no-connection outranks the cooldown, so a phantom recovery cannot hold it off", () => {
		const plan = planStallRecovery(input({ hasConnection: false, lastRefreshAt: NOW - 1 }));
		expect(plan.action).toBe("retry-soon");
	});

	test("waits while a genuine recovery is still inside its cooldown", () => {
		expect(planStallRecovery(input({ lastRefreshAt: NOW - 1 })).action).toBe("wait");
		expect(
			planStallRecovery(input({ lastRefreshAt: NOW - SQUARE_STALL_RECOVERY_COOLDOWN_MS + 1 })).action,
		).toBe("wait");
	});

	test("refreshes again once the cooldown has elapsed", () => {
		const plan = planStallRecovery(
			input({ lastRefreshAt: NOW - SQUARE_STALL_RECOVERY_COOLDOWN_MS, failedRefreshes: 1 }),
		);
		expect(plan).toMatchObject({ action: "refresh", attempt: 2 });
	});

	// The other half of the bug: the old watchdog only ever knew one move, so a
	// stall a reconnect could not fix repeated until someone noticed.
	test("escalates to a rebuild after repeated refreshes fail to revive the chain", () => {
		const plan = planStallRecovery(
			input({
				lastRefreshAt: NOW - SQUARE_STALL_RECOVERY_COOLDOWN_MS,
				failedRefreshes: ESCALATE_AFTER_FAILED_REFRESHES,
			}),
		);
		expect(plan).toMatchObject({ action: "rebuild", attempts: ESCALATE_AFTER_FAILED_REFRESHES });
	});

	test("a recovered chain clears the escalation path even with failures on record", () => {
		const plan = planStallRecovery(
			input({ lastSquareFetchAt: NOW - 10, failedRefreshes: ESCALATE_AFTER_FAILED_REFRESHES + 5 }),
		);
		expect(plan.action).toBe("healthy");
	});

	// Reproduces the production timeline: five rounds, staleness growing by
	// exactly one cooldown each time. The old code answered "refresh" forever;
	// this must reach a rebuild instead of blinding the bot for over a minute.
	test("cannot repeat a useless refresh indefinitely — the 68s production stall now terminates", () => {
		const stalledAt = NOW;
		let lastRefreshAt: number | undefined;
		let failedRefreshes = 0;
		let rearmTried = false;
		const actions: Array<{ at: number; action: string }> = [];

		for (let tick = 0; tick <= 120_000; tick += 5_000) {
			const now = stalledAt + tick;
			const plan = planStallRecovery({
				now,
				lastSquareFetchAt: stalledAt, // never advances — the chain stays dead
				lastRefreshAt,
				hasConnection: true,
				failedRefreshes,
				rearmTried,
			});
			if (plan.action === "rearm") {
				rearmTried = true;
				actions.push({ at: tick, action: "rearm" });
			} else if (plan.action === "refresh") {
				lastRefreshAt = now;
				failedRefreshes++;
				actions.push({ at: tick, action: "refresh" });
			} else if (plan.action === "rebuild") {
				actions.push({ at: tick, action: "rebuild" });
				break;
			}
		}

		const names = actions.map((a) => a.action);
		expect(names[0]).toBe("rearm");
		expect(names).toContain("rebuild");
		expect(names.filter((a) => a === "refresh").length).toBe(ESCALATE_AFTER_FAILED_REFRESHES);

		// The unfixed code was still issuing useless refreshes at 68s with no
		// end in sight. Recovery must now be exhausted well before that.
		const rebuiltAt = actions.find((a) => a.action === "rebuild")!.at;
		expect(rebuiltAt).toBeLessThan(68_000);
	});
});
