/**
 * The record of everything that got between a trigger and its reply.
 *
 * Separate from `bot_events` on purpose. That feed answers "is the bot
 * running"; this one answers the question that actually costs money — "the
 * bot did not answer (or nobody saw it), what stopped it?" Mixing the two
 * is what turned the last incident into a week of guessing, so every
 * interference path writes exactly one row here, with the chat it happened
 * in, and the dashboard gets its own tab for them.
 *
 * Writes go through the same write-behind worker as latency samples: the
 * reply path never waits on a disk write, including when it is recording
 * its own failure.
 */
import { db } from "../db/sqlite.ts";
import { enqueueAnomaly } from "../db/write-behind.ts";
import type { AnomalyRow, AnomalySeverity } from "../db/schema.ts";

/**
 * Kinds are a closed set so the dashboard can label and filter them, and so
 * a typo cannot silently create a category nobody is looking at.
 */
export type AnomalyKind =
	/** A message we sent was deleted by someone in the room. */
	| "reply_destroyed"
	/** We answered a deletion by sending the reply again. */
	| "reply_resent"
	/** LINE accepted the send, but reading the room back does not find it. */
	| "reply_invisible"
	/** LINE accepted the send and reported a state other than SENT. */
	| "send_rejected"
	/** Our own rate limiter refused a reply the bot should have made. */
	| "send_dropped"
	/** A reply threw on its way to LINE. */
	| "send_failed"
	/** Same incoming message delivered repeatedly — possible flood. */
	| "duplicate_incoming"
	/** LINE delivered the trigger to us late, before our own clock started. */
	| "inbound_slow"
	/** The room's member/role list could not be read. */
	| "members_unreadable"
	/** The event stream died and the session had to be rebuilt. */
	| "listener_stopped"
	/** OpenChat's re-arm chain went silent while the session otherwise looked healthy — see session-manager.ts's square staleness watchdog. */
	| "square_stalled"
	/** LINE explicitly refused this bot access to an OpenChat; retrying a poll cannot repair membership or session access. */
	| "square_access_denied"
	/** A scheduled post's exact time arrived but it could not go out (bot offline, send failed). */
	| "scheduled_post_missed"
	/** A bot that was running when the process died could not be brought back on restart. */
	| "resume_failed";

export interface AnomalyInput {
	botId: number | null;
	kind: AnomalyKind;
	severity: AnomalySeverity;
	chatMid?: string | null;
	detail?: string;
}

/** Records one interference event. Never throws, never blocks. */
export function recordAnomaly(input: AnomalyInput): void {
	enqueueAnomaly({
		botId: input.botId,
		ts: Date.now(),
		kind: input.kind,
		severity: input.severity,
		chatMid: input.chatMid ?? null,
		detail: input.detail ?? null,
	});
}

export interface AnomalyQuery {
	botId?: number;
	kind?: string;
	severity?: AnomalySeverity;
	/** Only rows at or after this timestamp. */
	since?: number;
	limit?: number;
}

const MAX_LIMIT = 500;

/**
 * Newest first. Built as a parameterised query rather than interpolation —
 * every filter here comes off an HTTP request.
 */
export function listAnomalies(query: AnomalyQuery = {}): AnomalyRow[] {
	const where: string[] = [];
	const params: (string | number)[] = [];
	if (query.botId !== undefined) {
		where.push(`bot_id = ?${params.length + 1}`);
		params.push(query.botId);
	}
	if (query.kind) {
		where.push(`kind = ?${params.length + 1}`);
		params.push(query.kind);
	}
	if (query.severity) {
		where.push(`severity = ?${params.length + 1}`);
		params.push(query.severity);
	}
	if (query.since !== undefined) {
		where.push(`ts >= ?${params.length + 1}`);
		params.push(query.since);
	}
	const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? 200));
	params.push(limit);
	const sql = `SELECT id, bot_id, ts, kind, severity, chat_mid, detail FROM anomalies${
		where.length ? ` WHERE ${where.join(" AND ")}` : ""
	} ORDER BY ts DESC LIMIT ?${params.length}`;
	return db.query<AnomalyRow, (string | number)[]>(sql).all(...params);
}

/** Per-kind counts over a window, for the dashboard's summary strip. */
export function summarizeAnomalies(sinceMs: number, botId?: number): { kind: string; severity: string; count: number }[] {
	const sql = `SELECT kind, severity, COUNT(*) AS count FROM anomalies
		WHERE ts >= ?1${botId === undefined ? "" : " AND bot_id = ?2"}
		GROUP BY kind, severity ORDER BY count DESC`;
	const params: number[] = botId === undefined ? [sinceMs] : [sinceMs, botId];
	return db.query<{ kind: string; severity: string; count: number }, number[]>(sql).all(...params);
}

/** Drops a deleted bot's history. */
export function clearBotAnomalies(botId: number): void {
	db.query("DELETE FROM anomalies WHERE bot_id = ?1").run(botId);
}
