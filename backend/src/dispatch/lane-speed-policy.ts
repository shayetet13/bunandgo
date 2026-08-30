/**
 * SEND latency policy for Server 2 lanes. These are routing guardrails, not a promise about an external
 * network: when every route is slow the caller must still use the fastest
 * available one rather than drop a user's message.
 */

function nonNegativeEnv(name: string, fallback: number): number {
	const parsed = Number(process.env[name] ?? fallback);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Absolute backstop: a result above this always cools, even with nothing to
 * compare against. Kept for the cold path and dashboard labelling; steady-state
 * routing uses `effectiveSendSlowThresholdMs` below, which is relative to the
 * fastest lane actually measured this round.
 */
export const SEND_SLOW_THRESHOLD_MS = nonNegativeEnv("LINE_H2_SEND_SLOW_THRESHOLD_MS", 23);
/** Short enough to recover quickly, long enough that the next send can use a different route. */
export const SEND_SLOW_COOLDOWN_MS = Math.max(1_000, nonNegativeEnv("LINE_H2_SEND_SLOW_COOLDOWN_MS", 15_000));
/**
 * Hard floor for the relative threshold. A fixed 23ms sat below the live p50
 * once the upstream regressed, so nearly every send "cooled" and the selector
 * lost its ranking. The floor is the slowest a send may be before it is a
 * genuine outlier regardless of how fast the round's best lane looked.
 */
export const SEND_SLOW_FLOOR_MS = Math.max(1, nonNegativeEnv("LINE_H2_SEND_SLOW_FLOOR_MS", 28));
/** A lane trailing the round's fastest measured sibling by more than this factor is cooled. */
export const SEND_SLOW_RATIO = Math.max(1, nonNegativeEnv("LINE_H2_SEND_SLOW_RATIO", 1.5));

/**
 * The SEND-slow threshold to apply for one recorded result. A lane cools when it
 * is slower than *either* the absolute floor or `SEND_SLOW_RATIO` times the
 * fastest lane actually measured in the same pool — whichever is tighter — so a
 * fast pool holds its lanes to a fast bar while a genuinely degraded upstream
 * (every lane slow) still trips fail-open instead of a permanent cooldown. With
 * no measured sibling only the floor applies.
 */
export function effectiveSendSlowThresholdMs(fastestMeasuredMs: number | undefined): number {
	if (fastestMeasuredMs === undefined || !Number.isFinite(fastestMeasuredMs) || fastestMeasuredMs <= 0) {
		return SEND_SLOW_FLOOR_MS;
	}
	return Math.min(SEND_SLOW_FLOOR_MS, fastestMeasuredMs * SEND_SLOW_RATIO);
}

export interface SendCooldownCandidate {
	sendSlowUntil?: number;
}

/** A fast result clears an old cooldown immediately; a slow result starts a new one. */
export function nextSendSlowUntil(
	sampleMs: number,
	now: number = Date.now(),
	thresholdMs: number = SEND_SLOW_THRESHOLD_MS,
	cooldownMs: number = SEND_SLOW_COOLDOWN_MS,
): number {
	return Number.isFinite(sampleMs) && sampleMs > thresholdMs ? now + cooldownMs : 0;
}

/**
 * Prefer routes outside cooldown, but fail open to the full set when every
 * route is cooling. This preserves delivery while still choosing the lowest
 * measured RTT available during a network-wide slowdown.
 */
export function sendCandidatesOutsideCooldown<T extends SendCooldownCandidate>(candidates: T[], now: number = Date.now()): T[] {
	const available = candidates.filter((candidate) => (candidate.sendSlowUntil ?? 0) <= now);
	return available.length > 0 ? available : candidates;
}
