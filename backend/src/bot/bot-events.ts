import { enqueueBotEvent } from "../db/write-behind.ts";

/**
 * Persists a bot lifecycle event (started, went online/offline, error,
 * resumed after a restart, ...) for the admin dashboard's history view.
 *
 * Goes through the same write-behind worker as latency samples — a plain
 * `db.run` here would put disk I/O on threads that also drive the reply
 * hot path (session-manager runs on the main thread), which is exactly what
 * this project's speed guarantees rule out.
 */
export function logBotEvent(botId: number | null, type: string, message?: string): void {
	enqueueBotEvent({ botId, ts: Date.now(), type, message: message ?? null });
}
