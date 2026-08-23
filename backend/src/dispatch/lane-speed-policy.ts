/**
 * SEND latency policy shared by local Server 2 lanes and the Server 3 relay
 * candidate. These are routing guardrails, not a promise about an external
 * network: when every route is slow the caller must still use the fastest
 * available one rather than drop a user's message.
 */

function nonNegativeEnv(name: string, fallback: number): number {
	const parsed = Number(process.env[name] ?? fallback);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** A real result above this value temporarily removes the route from SEND selection. */
export const SEND_SLOW_THRESHOLD_MS = nonNegativeEnv("LINE_H2_SEND_SLOW_THRESHOLD_MS", 23);
/** Short enough to recover quickly, long enough that the next send can use a different route. */
export const SEND_SLOW_COOLDOWN_MS = Math.max(1_000, nonNegativeEnv("LINE_H2_SEND_SLOW_COOLDOWN_MS", 15_000));

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
