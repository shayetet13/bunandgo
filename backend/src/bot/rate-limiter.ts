/**
 * Synchronous admission control for outbound sends.
 *
 * A rate-limited message is deliberately dropped instead of queued. Waiting
 * here used to make a burst grow into seconds (or a full minute) of stale
 * replies, while still eventually sending every one of them to LINE. The bot
 * only needs the first eligible answer, so a send either reserves a slot now
 * or does not send at all.
 *
 * There used to be a second, per-bot minimum interval between sends (3.45
 * minutes, toggleable per bot). It was off on every bot in production and it
 * capped a racing bot at one answer per interval no matter how fast it was,
 * so it is gone. The rolling window below is what remains: a safety net
 * against runaway sends, always on, never skipped.
 */
const MAX_SENDS_PER_WINDOW = Number(process.env.SEND_MAX_PER_WINDOW ?? 20);
const WINDOW_MS = Number(process.env.SEND_WINDOW_MS ?? 60_000);

interface BotThrottleState {
	sentAt: number[];
}

export type SendDropReason = "window";

export interface SendAdmission {
	allowed: boolean;
	reason?: SendDropReason;
	retryAfterMs: number;
}

const states = new Map<number, BotThrottleState>();

function getState(botId: number): BotThrottleState {
	let state = states.get(botId);
	if (!state) {
		state = { sentAt: [] };
		states.set(botId, state);
	}
	return state;
}

/**
 * Atomically reserves an outbound slot when one is available right now.
 *
 * `now` is injectable for deterministic tests. Production callers use
 * `performance.now()`, a monotonic clock that cannot jump when the system
 * clock is corrected.
 */
export function tryAcquireSend(botId: number, now = performance.now()): SendAdmission {
	const state = getState(botId);

	let firstLive = 0;
	while (
		firstLive < state.sentAt.length &&
		now - state.sentAt[firstLive]! >= WINDOW_MS
	) {
		firstLive++;
	}
	if (firstLive > 0) state.sentAt.splice(0, firstLive);

	if (state.sentAt.length >= MAX_SENDS_PER_WINDOW) {
		return {
			allowed: false,
			reason: "window",
			retryAfterMs: Math.max(0, WINDOW_MS - (now - state.sentAt[0]!)),
		};
	}

	state.sentAt.push(now);
	return { allowed: true, retryAfterMs: 0 };
}

/** Drops a bot's in-memory limiter state when its session is deleted. */
export function clearThrottle(botId: number): void {
	states.delete(botId);
}
