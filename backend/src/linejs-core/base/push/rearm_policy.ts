/**
 * Decides how long to wait before re-arming a square fetch on the push
 * connection.
 *
 * Always re-arms — an empty answer is not treated as proof the server
 * won't hold the next one open, so this never stops trying for the fast,
 * inline delivery path. An empty answer still waits `idleDelayMs` before
 * the next attempt, which is what keeps a non-blocking server from being
 * spun on unthrottled.
 */

/**
 * Pause after an empty answer, so a non-blocking server cannot be spun.
 *
 * Deliberately small rather than zero: a server that answers instantly with
 * nothing is not holding the request open, and re-arming with no pause at
 * all turns that into an unthrottled loop against LINE's own infrastructure
 * — the kind of pattern that risks the account being flagged, not just a
 * slow reply. 20ms still bounds a quiet connection to on the order of tens
 * of requests per second instead of as many as the network round trip
 * allows — tightened from the original 50ms after measuring it as the
 * single largest contributor to OpenChat's inbound delay (average ~130ms
 * vs Talk's ~33ms on the same account). Exposed via env so it can be tuned
 * back up without a rebuild if it ever needs to be.
 */
export const DEFAULT_IDLE_DELAY_MS = Math.max(0, Number(globalThis.process?.env?.SQUARE_IDLE_DELAY_MS ?? 20));

export interface RearmDecision {
	/** Whether to send another sign-on request. */
	rearm: boolean;
	/** How long to wait before sending it. */
	delayMs: number;
}

export class SquareRearmPolicy {
	readonly #idleDelayMs: number;

	constructor(options: { idleDelayMs?: number } = {}) {
		this.#idleDelayMs = options.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS;
	}

	/** Records the outcome of a fetch and says what to do next. */
	next(eventCount: number): RearmDecision {
		return eventCount > 0 ? { rearm: true, delayMs: 0 } : { rearm: true, delayMs: this.#idleDelayMs };
	}
}
