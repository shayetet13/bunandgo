import type { FetchDirection, SquareEvent } from "../linejs-core/types/line_types.ts";

/**
 * The per-room path exists for latency, not reliability: the normal Square
 * push remains connected beside it. LINE often batches fetchMyEvents for
 * roughly 100ms, while fetchSquareChatEvents on a warm Tokyo connection can
 * turn around in the low tens of milliseconds. Racing the two sources and
 * deduplicating by message id lets whichever one sees the trigger first win.
 */
export const FAST_SQUARE_POLL_ENABLED = process.env.SQUARE_FAST_POLL !== "0";
/** A quiet period prevents an idle room from continuously occupying a stream. */
// An interval of zero means no artificial sleep after a completed request. It
// does not overlap requests: fetchWithTimeout is awaited before the next loop,
// so LINE's own round-trip time remains the hard throughput ceiling. This mode
// is reserved for a worker with separate send lanes and an explicit fast-slot
// budget. Gates prevent stale 0/50ms values from becoming active merely
// because code is upgraded.
const ZERO_DELAY_FAST_SQUARE_POLL_INTERVAL_MS = 0;
const ISOLATED_FAST_SQUARE_POLL_INTERVAL_MS = 50;
const DEFAULT_FAST_SQUARE_POLL_INTERVAL_MS = 100;
/** Largest delay supported by JS timers; larger values otherwise become 1ms. */
const MAX_FAST_SQUARE_POLL_INTERVAL_MS = 2_147_483_647;

export function resolveFastSquarePollIntervalMs(
	configuredRaw: string | undefined,
	allow50MsRaw: string | undefined,
	allowZeroMsRaw: string | undefined = undefined,
): number {
	if (configuredRaw === undefined || configuredRaw.trim() === "") {
		return DEFAULT_FAST_SQUARE_POLL_INTERVAL_MS;
	}
	const configured = Number(configuredRaw);
	if (!Number.isFinite(configured)) return DEFAULT_FAST_SQUARE_POLL_INTERVAL_MS;
	const minimum = allowZeroMsRaw === "1"
		? ZERO_DELAY_FAST_SQUARE_POLL_INTERVAL_MS
		: allow50MsRaw === "1"
			? ISOLATED_FAST_SQUARE_POLL_INTERVAL_MS
			: DEFAULT_FAST_SQUARE_POLL_INTERVAL_MS;
	return Math.min(MAX_FAST_SQUARE_POLL_INTERVAL_MS, Math.max(minimum, Math.ceil(configured)));
}

export const FAST_SQUARE_POLL_INTERVAL_MS = resolveFastSquarePollIntervalMs(
	process.env.SQUARE_FAST_POLL_INTERVAL_MS,
	process.env.SQUARE_FAST_POLL_ALLOW_50MS,
	process.env.SQUARE_FAST_POLL_ALLOW_ZERO_MS,
);

/**
 * Number of simultaneous sub-100ms poll streams this worker may own. One slot
 * maps to one non-send H2 lane; clamping to that lane budget prevents several
 * zero-delay cursors from silently multiplexing over a saturated connection.
 */
export function resolveFastSquarePollSlots(
	configuredRaw: string | undefined,
	laneCountRaw: string | undefined,
	sendReservedRaw: string | undefined,
): number {
	const laneCount = Math.max(1, Math.trunc(Number(laneCountRaw ?? 6)) || 6);
	const sendReserved = Math.min(laneCount - 1, Math.max(0, Math.trunc(Number(sendReservedRaw ?? 0)) || 0));
	const pollLanes = Math.max(1, laneCount - sendReserved);
	const configured = Math.trunc(Number(configuredRaw ?? 1));
	return Math.min(pollLanes, Number.isFinite(configured) ? Math.max(1, configured) : 1);
}

export const FAST_SQUARE_POLL_SLOTS = resolveFastSquarePollSlots(
	process.env.SQUARE_FAST_POLL_SLOTS,
	process.env.LINE_H2_LANES,
	process.env.LINE_H2_SEND_RESERVED_LANES,
);

/** Stable admission: existing fast bots keep their slot; a newcomer cannot
 * downgrade every established bot merely by coming online. */
export class FastSquarePollSlotPool {
	readonly #botIds = new Set<number>();
	constructor(readonly capacity: number) {}

	acquire(botId: number): boolean {
		if (this.#botIds.has(botId)) return true;
		if (this.#botIds.size >= this.capacity) return false;
		this.#botIds.add(botId);
		return true;
	}

	release(botId: number): boolean {
		return this.#botIds.delete(botId);
	}

	has(botId: number): boolean {
		return this.#botIds.has(botId);
	}

	get size(): number {
		return this.#botIds.size;
	}
}
/**
 * How many OpenChats one bot may fast-poll at once.
 *
 * This is the knob that decides whether covering four rooms costs four LINE
 * accounts or one. A bot is one account, so a budget of one forces a room
 * to buy its own account — which is the expensive way to solve a problem
 * that is really about how many request streams this process can afford.
 *
 * Raising it multiplies continuous polling against the same connection pool
 * the replies use, which is exactly what made FAST_SQUARE_POLL_WORKERS=2
 * measure worse — so it moves one room at a time, with a number to compare
 * against each time.
 *
 * At 2 since 2026-08-10. Baseline taken immediately before, over the 112
 * auto-replies since that day's purge: latency 26.8ms, inbound 32.0ms. If
 * the next window is materially worse, this is the first thing to put back
 * to 1 — and LINE_H2_SEND_RESERVED_LANES is the knob to try before raising
 * it further, since lane contention is what this runs into first.
 */
const configuredFastSquarePollRooms = Number(process.env.SQUARE_FAST_POLL_MAX_ROOMS ?? 1);
export const FAST_SQUARE_POLL_MAX_ROOMS_REQUESTED = Number.isFinite(configuredFastSquarePollRooms)
	? Math.min(8, Math.max(0, Math.trunc(configuredFastSquarePollRooms)))
	: 1;
/** Exactly one dedicated poll is allowed per LINE session. */
export const FAST_SQUARE_POLL_MAX_ROOMS = Math.min(1, FAST_SQUARE_POLL_MAX_ROOMS_REQUESTED);

/**
 * Concurrent polls per room. Leave this at 1.
 *
 * The idea was that a second independently-tokened request covers the blind
 * spot while the first is in flight. Measured against a live OpenChat room on
 * 2026-08-09, raising it to 2 roughly doubled reply latency — 17.8ms -> 36.3ms
 * total, with `upstream` alone going 16.6ms -> 35.5ms. The extra poll does not
 * fill a gap, it competes with the reply it is supposed to be racing for.
 *
 * Values above one used to remain configurable. That made an accidental
 * `SQUARE_FAST_POLL_WORKERS=8` turn two selected rooms into sixteen
 * overlapping cursors, all sharing the same account and H2 lanes. The result
 * is neither an independent receive path nor a useful hedge: it is contention
 * and eight copies of every permanent error.
 *
 * Keep the requested value only for the startup diagnostic, then cap the
 * actual topology at one dedicated cursor per bot + room. This is the same
 * shape as a per-room listener, while preserving the ordinary Square push
 * listener as the second, deduplicated source.
 */
const configuredFastSquarePollWorkers = Number(process.env.SQUARE_FAST_POLL_WORKERS ?? 1);
export const FAST_SQUARE_POLL_WORKERS_REQUESTED = Number.isFinite(configuredFastSquarePollWorkers)
	? Math.min(8, Math.max(1, Math.trunc(configuredFastSquarePollWorkers)))
	: 1;
export const FAST_SQUARE_POLL_WORKERS = 1;

const INITIAL_DRAIN_LIMIT = Math.max(1, Number(process.env.SQUARE_FAST_POLL_INITIAL_DRAIN_LIMIT ?? 10));
const ERROR_BACKOFF_MIN_MS = 50;
const ERROR_BACKOFF_MAX_MS = 1_000;

/**
 * Bounds one `fetchEvents` call. Nothing below this — not `laneFetch`, not
 * the thrift client — currently times out a stream LINE opened and then
 * never answered: that request just hangs, forever, with no error to catch
 * and back off from. A room stuck this way looks identical to a quiet room
 * from every existing signal (the account-wide push watchdog only reads
 * `lastSquareFetchAt`, which other rooms keep advancing) — this is the one
 * place that can catch it, because it is the one place that is per-room.
 *
 * The timeout is propagated to the underlying request. A timed-out poll must
 * close its stream before this loop starts another request with the same
 * sync token.
 */
const FETCH_TIMEOUT_MS = Math.max(1_000, Number(process.env.SQUARE_FAST_POLL_FETCH_TIMEOUT_MS ?? 15_000));

export interface FastSquareFetchOptions {
	squareChatMid: string;
	syncToken?: string;
	limit: number;
	direction: FetchDirection;
	timeoutMs: number;
}

export interface FastSquareFetchResponse {
	events: SquareEvent[];
	syncToken: string;
}

export interface FastSquarePollerOptions {
	squareChatMid: string;
	signal: AbortSignal;
	/** Implementations must stop their I/O when `signal` aborts. */
	fetchEvents: (options: FastSquareFetchOptions, signal: AbortSignal) => Promise<FastSquareFetchResponse>;
	onEvent: (event: SquareEvent, receivedAt: number) => void;
	onError?: (error: unknown, consecutiveFailures: number) => void;
	intervalMs?: number;
	/** Delays the first request; useful for controlled tests. */
	initialDelayMs?: number;
	/** Overrides FETCH_TIMEOUT_MS; exists for tests, not meant to be tuned per-room. */
	fetchTimeoutMs?: number;
}

async function fetchWithTimeout(
	fetchEvents: FastSquarePollerOptions["fetchEvents"],
	options: FastSquareFetchOptions,
	parentSignal: AbortSignal,
): Promise<FastSquareFetchResponse> {
	const controller = new AbortController();
	const timeoutError = new Error(`fast-poll fetch timed out after ${options.timeoutMs}ms`);
	const abortFromParent = (): void => controller.abort(parentSignal.reason);
	if (parentSignal.aborted) abortFromParent();
	else parentSignal.addEventListener("abort", abortFromParent, { once: true });
	const timer = setTimeout(() => controller.abort(timeoutError), options.timeoutMs);

	try {
		// Do not race this promise with a timer: waiting for the aborted request
		// to settle is what prevents old and new cursors from overlapping.
		return await fetchEvents(options, controller.signal);
	} finally {
		clearTimeout(timer);
		parentSignal.removeEventListener("abort", abortFromParent);
	}
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0 || signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		function done(): void {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

/**
 * Polls one enabled OpenChat as fast as the upstream round trip permits.
 *
 * Startup history is drained before delivery so turning the fast path on
 * cannot answer an old keyword. The ordinary push listener is already live
 * during this short priming window, so a genuinely new trigger is not lost.
 */
export async function runFastSquarePoller(options: FastSquarePollerOptions): Promise<void> {
	const intervalMs = options.intervalMs ?? FAST_SQUARE_POLL_INTERVAL_MS;
	const fetchTimeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
	let syncToken: string | undefined;
	let primed = false;
	let drainCalls = 0;
	let consecutiveFailures = 0;

	await waitFor(options.initialDelayMs ?? 0, options.signal);

	while (!options.signal.aborted) {
		try {
			const response = await fetchWithTimeout(
				options.fetchEvents,
				{
					squareChatMid: options.squareChatMid,
					syncToken,
					limit: 50,
					direction: "FORWARD",
					timeoutMs: fetchTimeoutMs,
				},
				options.signal,
			);
			if (options.signal.aborted) break;

			const receivedAt = performance.now();
			syncToken = response.syncToken;
			consecutiveFailures = 0;

			if (!primed) {
				drainCalls++;
				// An empty page is the clean history boundary. The cap prevents a
				// permanently busy room from keeping its fast path disabled forever.
				if (response.events.length === 0 || drainCalls >= INITIAL_DRAIN_LIMIT) {
					primed = true;
				}
			} else {
				// Synchronous by design: the handler starts the reply request before
				// this poller updates timers or asks LINE for the next page.
				for (const event of response.events) options.onEvent(event, receivedAt);
			}

			await waitFor(intervalMs, options.signal);
		} catch (error) {
			if (options.signal.aborted) break;
			consecutiveFailures++;
			options.onError?.(error, consecutiveFailures);
			const backoff = Math.min(ERROR_BACKOFF_MAX_MS, ERROR_BACKOFF_MIN_MS * 2 ** Math.min(consecutiveFailures - 1, 5));
			await waitFor(backoff, options.signal);
		}
	}
}
