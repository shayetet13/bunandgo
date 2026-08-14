/**
 * Decides what to do about an OpenChat receive path that has gone silent.
 *
 * Split out as a pure function because the bug it exists to prevent was a
 * decision bug, not a networking one: the old watchdog closed the push
 * connection, marked itself as having recovered, and waited a fixed cooldown —
 * whether or not the close had actually happened or helped. Production showed
 * that loop running five times against one stall with the staleness growing by
 * exactly the cooldown each round (8.1s → 23.1s → 38.1s → 53.1s → 68.1s): a
 * 68-second blind window during which the bot reported itself online and could
 * not see a single message.
 *
 * Two holes produced that. Both are decisions, so both are tested here:
 *
 *  1. When `conns[0]` was already gone there was nothing to close, but the
 *     cooldown was armed anyway — so the watchdog spent 15 seconds "waiting
 *     for a recovery" that had never been attempted. `plan` answers
 *     `retry-soon` there instead, so the next 5s tick tries again.
 *
 *  2. Closing the connection was the only move available, forever. If the
 *     reconnect came back but nothing re-armed the square fetch chain, the
 *     watchdog would keep issuing a close that could not fix it. After
 *     `ESCALATE_AFTER_FAILED_REFRESHES` rounds `plan` answers `rebuild`, which
 *     costs a full session rebuild but ends the blindness.
 */

/** How long a square fetch may be outstanding before the chain counts as stalled. */
export const SQUARE_STALL_MS = Math.max(1_000, Number(process.env.SQUARE_STALL_MS ?? 8_000));

/**
 * How long to leave a genuinely-attempted recovery alone. A fresh connection
 * needs a few seconds to resubscribe and post its first fetch, and re-closing
 * it mid-reconnect only restarts that clock.
 */
export const SQUARE_STALL_RECOVERY_COOLDOWN_MS = Math.max(
	1_000,
	Number(process.env.SQUARE_STALL_RECOVERY_COOLDOWN_MS ?? 15_000),
);

/**
 * Consecutive close-the-connection attempts that failed to restore the chain
 * before giving up on it and rebuilding the whole session. Three rounds of the
 * cooldown is ~45s of blindness — long, but a rebuild drops and re-establishes
 * every LINE session for the bot, so it must not fire on the first hiccup.
 */
export const ESCALATE_AFTER_FAILED_REFRESHES = Math.max(
	1,
	Number(process.env.SQUARE_STALL_ESCALATE_AFTER ?? 3),
);

export type StallAction =
	/** Chain is alive (or too early to judge) — do nothing. */
	| { action: "healthy" }
	/** A recovery is already in flight; leave it alone until the cooldown ends. */
	| { action: "wait" }
	/** Arm one square fetch on the existing connection — cheapest repair, no teardown. */
	| { action: "rearm"; staleMs: number }
	/** Close the push connection so the pusher loop rebuilds it. */
	| { action: "refresh"; staleMs: number; attempt: number }
	/** Nothing to close — try again on the next tick rather than arming a cooldown. */
	| { action: "retry-soon"; staleMs: number }
	/** Repeated refreshes did not help; rebuild the session. */
	| { action: "rebuild"; staleMs: number; attempts: number };

export interface StallInput {
	now: number;
	/** `ConnManager.lastSquareFetchAt` — advances on every fetch response, empty or not. */
	lastSquareFetchAt: number;
	/** When a recovery was last actually attempted, or undefined if never. */
	lastRefreshAt?: number;
	/** Whether a push connection currently exists to be closed. */
	hasConnection: boolean;
	/** Consecutive recovery attempts so far that did not bring the chain back. */
	failedRefreshes: number;
	/** Whether the cheap in-place re-arm has already been tried for this stall. */
	rearmTried: boolean;
}

export function planStallRecovery(input: StallInput): StallAction {
	const staleMs = input.now - input.lastSquareFetchAt;
	if (staleMs < SQUARE_STALL_MS) return { action: "healthy" };

	// No connection means the close below would be a no-op. Reporting that as a
	// recovery is the exact lie that produced the 68-second window, so it gets
	// its own answer and never arms the cooldown.
	if (!input.hasConnection) return { action: "retry-soon", staleMs };

	// Cheapest repair first, and without waiting out a cooldown: re-arming
	// costs one request on a connection that is already open and changes no
	// visible state, so there is nothing to protect with a backoff. It also
	// targets the actual failure — a chain that stopped re-arming itself —
	// rather than assuming the connection underneath it is what broke.
	if (!input.rearmTried) return { action: "rearm", staleMs };

	const sinceRefresh = input.now - (input.lastRefreshAt ?? Number.NEGATIVE_INFINITY);
	if (sinceRefresh < SQUARE_STALL_RECOVERY_COOLDOWN_MS) return { action: "wait" };

	if (input.failedRefreshes >= ESCALATE_AFTER_FAILED_REFRESHES) {
		return { action: "rebuild", staleMs, attempts: input.failedRefreshes };
	}
	return { action: "refresh", staleMs, attempt: input.failedRefreshes + 1 };
}
