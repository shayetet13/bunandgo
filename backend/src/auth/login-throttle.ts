/**
 * Brute-force guard for POST /api/auth/login only — separate from
 * `bot/rate-limiter.ts`, which throttles outbound LINE sends and must stay
 * untouched. This limiter blocks the HTTP login endpoint, not any bot path.
 */
const MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS ?? 10);
const WINDOW_MS = Number(process.env.LOGIN_WINDOW_MS ?? 5 * 60_000);

/**
 * Caps how many distinct `key`s (ip|username pairs — see auth.ts) this
 * throttle tracks at once.
 *
 * Every other in-memory cache in this codebase (reply-guard.ts's claims,
 * automatic-reply-echo.ts, start-confirmation.ts) bounds itself; this one
 * previously didn't, despite being reachable from an unauthenticated
 * endpoint (`POST /api/auth/login`) — a stream of login attempts using many
 * distinct usernames would otherwise grow this map without limit for as
 * long as the process runs.
 */
const MAX_TRACKED_KEYS = Number(process.env.LOGIN_THROTTLE_MAX_KEYS ?? 20_000);

/** Map insertion order doubles as an O(1) eviction queue — see `touch`. */
const attemptsByKey = new Map<string, number[]>();

function pruneOld(timestamps: number[], now: number): number[] {
	return timestamps.filter((ts) => now - ts < WINDOW_MS);
}

function evictOldestAtCapacity(): void {
	if (attemptsByKey.size < MAX_TRACKED_KEYS) return;
	const oldest = attemptsByKey.keys().next().value;
	if (oldest !== undefined) attemptsByKey.delete(oldest);
}

/**
 * Records a key's latest timestamps, moving it to the newest position in
 * the map's insertion order.
 *
 * A plain `Map.set` on an *existing* key updates its value without moving
 * it — so a key touched on every request (an actively-throttled, currently
 * misbehaving caller, exactly the one we most want to keep) would stay at
 * its original, increasingly stale position and be first in line for
 * eviction under `evictOldestAtCapacity`. Deleting before re-inserting
 * makes "oldest" mean "least recently touched", not "created longest ago".
 */
function touch(key: string, timestamps: number[]): void {
	attemptsByKey.delete(key);
	evictOldestAtCapacity();
	attemptsByKey.set(key, timestamps);
}

export interface LoginAdmission {
	allowed: boolean;
	retryAfterMs: number;
}

/** Call once per login attempt (success or failure) before checking credentials. */
export function tryAcquireLoginAttempt(key: string, now = Date.now()): LoginAdmission {
	const live = pruneOld(attemptsByKey.get(key) ?? [], now);
	if (live.length >= MAX_ATTEMPTS) {
		touch(key, live);
		return { allowed: false, retryAfterMs: WINDOW_MS - (now - live[0]!) };
	}
	live.push(now);
	touch(key, live);
	return { allowed: true, retryAfterMs: 0 };
}

/** Call on a successful login to stop a legitimate user from being penalized by earlier typos. */
export function clearLoginAttempts(key: string): void {
	attemptsByKey.delete(key);
}
