import { db } from "../db/sqlite.ts";

/**
 * A short poll-quiet window applied after a Square reply is dispatched.
 *
 * The dedicated fast poller (fast-square-poller.ts) runs its `fetchSquareChatEvents`
 * loop at or near zero delay. Measured over 7 days of live replies, a send that
 * goes out while that loop has a fetch in flight for the same account completes
 * in ~23ms; the same send with the account otherwise idle completes in ~10ms.
 * Reserved send lanes do not close the gap because the contention is at LINE's
 * per-account request handling, not the local H2 lanes.
 *
 * So once a reply for a room is on its way, this module lets that room's cursor
 * hold its next fetch for `windowMs`, trading a few ms of detection latency on
 * the *next* message (only while a conversation is active) for a large cut on
 * the reply that is in flight now.
 *
 * The window is persisted in the shared `app_meta` table and refreshed every
 * few seconds: a restart drops bot sessions and is never required to change
 * or disable it. The default is a conservative 15ms based on the measured
 * poll/send contention gap; set the environment variable or persisted value
 * to 0 to turn it off for an A/B baseline.
 */
const QUIET_META_KEY = "square.fast_poll.quiet_ms";
const CONFIG_REFRESH_MS = 5_000;
const QUIET_MIN_MS = 0;
/** Above this, the detection cost on a busy room's follow-up message stops being a fair trade. */
const QUIET_MAX_MS = 40;
/** Production starting point for the poll/send contention A/B test. */
const QUIET_DEFAULT_MS = 15;
/** Rooms answered concurrently fleet-wide is tiny; this is only a leak guard. */
const MAX_TRACKED_ROOMS = 512;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function envDefaultQuietMs(): number {
	const raw = Number(process.env.SQUARE_FAST_POLL_QUIET_MS ?? QUIET_DEFAULT_MS);
	return Number.isFinite(raw) ? clamp(Math.round(raw), QUIET_MIN_MS, QUIET_MAX_MS) : QUIET_DEFAULT_MS;
}

/**
 * Validates an untrusted value. Throws with a user-facing Thai message so the
 * API can return it verbatim.
 */
export function parseQuietMs(input: unknown): number {
	const value = typeof input === "object" && input !== null ? (input as Record<string, unknown>).quietMs : input;
	const ms = Number(value);
	if (!Number.isFinite(ms) || !Number.isInteger(ms)) {
		throw new Error("quietMs ต้องเป็นจำนวนเต็ม (มิลลิวินาที)");
	}
	if (ms < QUIET_MIN_MS || ms > QUIET_MAX_MS) {
		throw new Error(`quietMs ต้องอยู่ระหว่าง ${QUIET_MIN_MS}-${QUIET_MAX_MS} ms (0 = ปิด)`);
	}
	return ms;
}

const readConfigStmt = db.prepare<{ value: string }, [string]>("SELECT value FROM app_meta WHERE key = ?");
const writeConfigStmt = db.prepare<null, [string, string]>(
	"INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);

function readPersistedQuietMs(): number | undefined {
	const raw = readConfigStmt.get(QUIET_META_KEY)?.value;
	if (raw === undefined) return undefined;
	try {
		return parseQuietMs(raw.trim());
	} catch {
		// A malformed row must never take a worker down; the env default keeps
		// the process healthy until the row is rewritten.
		return undefined;
	}
}

let activeQuietMs: number = readPersistedQuietMs() ?? envDefaultQuietMs();

/** Current per-process view of the shared window, in milliseconds. 0 = disabled. */
export function squarePollQuietWindowMs(): number {
	return activeQuietMs;
}

/** Re-reads app_meta immediately; used by the refresh timer and by tests. */
export function refreshSquarePollQuietConfig(): number {
	activeQuietMs = readPersistedQuietMs() ?? envDefaultQuietMs();
	return activeQuietMs;
}

/**
 * Persists and applies a validated window. The write lands in the shared
 * SQLite file, so every worker converges within CONFIG_REFRESH_MS with no
 * restart.
 */
export function applySquarePollQuietMs(quietMs: number): number {
	const value = clamp(Math.round(quietMs), QUIET_MIN_MS, QUIET_MAX_MS);
	writeConfigStmt.run(QUIET_META_KEY, String(value));
	activeQuietMs = value;
	return value;
}

if (process.env.NODE_ENV !== "test") {
	const timer = setInterval(refreshSquarePollQuietConfig, CONFIG_REFRESH_MS);
	// One tiny indexed read every 5s must never keep the process alive.
	timer.unref?.();
}

/** squareChatMid -> performance.now() timestamp the cursor may fetch again. */
const quietUntil = new Map<string, number>();

function pruneExpired(now: number): void {
	for (const [mid, until] of quietUntil) {
		if (until <= now) quietUntil.delete(mid);
	}
}

/**
 * Called from the reply path the instant a Square send is committed for
 * `squareChatMid`. No-op while the window is 0, so a disabled feature adds
 * nothing but a map lookup.
 */
export function markSquareReplyDispatched(squareChatMid: string, now: number = performance.now()): void {
	const window = activeQuietMs;
	if (window <= 0) return;
	pruneExpired(now);
	if (!quietUntil.has(squareChatMid) && quietUntil.size >= MAX_TRACKED_ROOMS) {
		const oldest = quietUntil.keys().next().value as string | undefined;
		if (oldest !== undefined) quietUntil.delete(oldest);
	}
	quietUntil.set(squareChatMid, now + window);
}

/**
 * Milliseconds the fast poll cursor for `squareChatMid` should still hold its
 * next fetch. 0 when no reply is in flight (the common case) or the window has
 * elapsed.
 */
export function squarePollQuietRemainingMs(squareChatMid: string, now: number = performance.now()): number {
	const until = quietUntil.get(squareChatMid);
	if (until === undefined) return 0;
	const remaining = until - now;
	if (remaining <= 0) {
		quietUntil.delete(squareChatMid);
		return 0;
	}
	return remaining;
}

/** Test-only: drop all per-room quiet state. */
export function resetSquarePollQuietState(): void {
	quietUntil.clear();
}
