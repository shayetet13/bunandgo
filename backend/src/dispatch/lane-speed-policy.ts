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
 * Hard floor for the relative threshold — the slowest a send may be before it
 * is a genuine outlier regardless of how fast the round's best lane looked.
 *
 * History: 28 -> 23 -> 20 -> 23 (this value), each step against measured
 * production, not guessed. The 7-day sample behind the 23->20 drop (n=1040)
 * had p50 19.9ms — 20 looked like it had ~0.1ms of headroom above that
 * median. It did not survive contact with live traffic: within about an
 * hour of deploying 20 on 2026-08-31, SEND on Server 2 was averaging
 * 35-49ms with a 55% cool-down rate in 5-minute windows (queried directly
 * from lane_race_events), matching exactly the failure mode warned about
 * below — a floor sitting on top of the median starts cooling the median
 * lane itself the moment real RTT drifts a fraction above its 7-day-old
 * baseline, and once enough lanes cool at once the pool can't hold a
 * ranking. 23 restores the original margin above that median with room to
 * spare, and matches this exact codebase's own prior tuning history
 * (see `da59d64`/`425c78a`: 19 -> 20 -> 21 -> 23 over 2026-08-21/22) —
 * this is not a new number, it's the one that already proved stable here.
 *
 * Do not retighten this from a stale sample again. If production RTT has
 * genuinely improved, confirm it holds over multiple days across traffic
 * patterns (not one good hour) before moving this back down, and change it
 * by itself — not bundled with an unrelated feature — so a regression is
 * traceable to exactly this number.
 */
export const SEND_SLOW_FLOOR_MS = Math.max(1, nonNegativeEnv("LINE_H2_SEND_SLOW_FLOOR_MS", 23));
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

/**
 * Hysteresis band for the per-bot "hold this lane" pin (see
 * `selectFastestSendLaneCandidate` in h2-lanes.ts). A lane a bot has
 * measured under `SEND_PIN_ENTER_MS` is worth remembering; once remembered
 * it keeps winning a *genuine tie* against a statistically identical
 * alternative — instead of round robin rotating the bot off it — until its
 * own score reaches `SEND_PIN_EXIT_MS`.
 *
 * This is deliberately narrower than the SEND_SLOW_* cooldown above: it can
 * only ever decide between candidates already scored within
 * `APPLICATION_SWITCH_MARGIN_MS` (0.1ms) of each other, so a lane that is
 * genuinely faster — not just tied — always wins outright regardless of any
 * pin, and a pinned lane that itself cools via `SEND_SLOW_FLOOR_MS` drops out
 * of the candidate list entirely and cannot be tied with anything. Widening
 * this beyond tie-breaking would let one lane take every send for a bot and
 * reintroduce the "reserved lanes go cold and unmeasured" regression the
 * round-robin tie-break exists to prevent (see NETWORK-LANE-RACE.md).
 *
 * 21/23 default split: exit matches `SEND_SLOW_FLOOR_MS` (23) — a pinned
 * lane that has drifted enough to cool has also drifted enough to lose the
 * pin, both on the same line. Enter sits 2ms inside that at 21, which is
 * where a lane must have proven itself to be worth remembering in the first
 * place, not merely tolerated. Both numbers are the same ones this codebase
 * already carried in production before (see `da59d64`/`425c78a`), not a
 * fresh guess.
 */
export const SEND_PIN_ENTER_MS = nonNegativeEnv("LINE_H2_SEND_PIN_ENTER_MS", 21);
/** Never below the enter line — an inverted band would let a lane hold the pin without ever having qualified for it. */
export const SEND_PIN_EXIT_MS = Math.max(SEND_PIN_ENTER_MS, nonNegativeEnv("LINE_H2_SEND_PIN_EXIT_MS", 23));

/** True once a candidate's score is fast enough to newly earn the hold-this-lane pin. */
export function qualifiesForSendPin(scoreMs: number, enterMs: number = SEND_PIN_ENTER_MS): boolean {
	return Number.isFinite(scoreMs) && scoreMs < enterMs;
}

/** True while an already-pinned lane's current score is still fast enough to keep winning ties. */
export function holdsSendPin(scoreMs: number, exitMs: number = SEND_PIN_EXIT_MS): boolean {
	return Number.isFinite(scoreMs) && scoreMs < exitMs;
}
