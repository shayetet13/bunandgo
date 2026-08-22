import { db } from "../db/sqlite.ts";
import type { ScheduledPostRow, Surface } from "../db/schema.ts";

/**
 * A post that fires at an exact wall-clock time instead of a keyword — the
 * "no keyword" rule: pick a date, month, year, and time (Asia/Bangkok) and
 * the bot posts the prepared text the instant the clock hits it, so it can
 * be first without waiting on anyone to type anything.
 */
export interface ScheduledPost {
	id: number;
	botId: number;
	surface: Surface;
	targetMid: string;
	text: string;
	/** Epoch ms — the exact instant to fire, already resolved from Bangkok wall time. */
	runAt: number;
	enabled: boolean;
	/** Epoch ms the send actually went out, or null while still pending. */
	sentAt: number | null;
}

function fromRow(row: ScheduledPostRow): ScheduledPost {
	return {
		id: row.id,
		botId: row.bot_id,
		surface: row.surface,
		targetMid: row.target_mid,
		text: row.text,
		runAt: row.run_at,
		enabled: row.enabled === 1,
		sentAt: row.sent_at,
	};
}

const MAX_TEXT_LENGTH = Number(process.env.SCHEDULED_POST_MAX_TEXT ?? 4096);
// Small grace so a create/update whose runAt is a couple seconds behind the
// server's clock (client clock skew, a slow submit) isn't rejected as "in
// the past" for a time the user genuinely picked as "now-ish". Kept
// numerically in sync by hand with the frontend's own copy of this check
// (frontend/src/lib/scheduled-post-status.ts's RUN_AT_PAST_GRACE_MS) — no
// shared package between the two, but both need to agree, or a submit right
// at the boundary can be accepted by one side and rejected by the other.
const PAST_GRACE_MS = 2_000;

const TARGET_MID_PATTERN: Record<Surface, RegExp> = {
	talk: /^[urc][0-9a-f]{32}$/i,
	square: /^m[0-9a-f]{32}$/i,
};

export class ScheduledPostValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ScheduledPostValidationError";
	}
}

export interface ScheduledPostInput {
	surface: Surface;
	targetMid: string;
	text: string;
	runAt: number;
	enabled: boolean;
}

function assertScheduledPostInput(input: ScheduledPostInput): void {
	if (!input || !["talk", "square"].includes(input.surface)) {
		throw new ScheduledPostValidationError("surface must be talk or square");
	}
	if (typeof input.targetMid !== "string" || !TARGET_MID_PATTERN[input.surface].test(input.targetMid)) {
		throw new ScheduledPostValidationError("targetMid is invalid for surface");
	}
	if (typeof input.text !== "string" || !input.text.trim()) {
		throw new ScheduledPostValidationError("text is required");
	}
	if (input.text.length > MAX_TEXT_LENGTH) {
		throw new ScheduledPostValidationError(`text must not exceed ${MAX_TEXT_LENGTH} characters`);
	}
	if (!Number.isInteger(input.runAt)) {
		throw new ScheduledPostValidationError("runAt must be an epoch-ms integer");
	}
	if (input.runAt < Date.now() - PAST_GRACE_MS) {
		throw new ScheduledPostValidationError("runAt must be in the future");
	}
	if (typeof input.enabled !== "boolean") {
		throw new ScheduledPostValidationError("enabled must be boolean");
	}
}

const listStmt = db.prepare<ScheduledPostRow, [number]>("SELECT * FROM scheduled_posts WHERE bot_id = ? ORDER BY run_at ASC, id ASC");
const getStmt = db.prepare<ScheduledPostRow, [number, number]>("SELECT * FROM scheduled_posts WHERE bot_id = ? AND id = ?");
const insertStmt = db.prepare<ScheduledPostRow, [number, Surface, string, string, number, number, number]>(
	"INSERT INTO scheduled_posts (bot_id, surface, target_mid, text, run_at, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *",
);
// Editing a schedule re-arms it: sent_at resets to NULL so a post edited
// after it already fired once (or after its time slipped by) runs again at
// the newly chosen time instead of silently staying "already sent".
const updateStmt = db.prepare<null, [Surface, string, string, number, number, number, number]>(
	"UPDATE scheduled_posts SET surface = ?, target_mid = ?, text = ?, run_at = ?, enabled = ?, sent_at = NULL WHERE id = ? AND bot_id = ?",
);
const deleteStmt = db.prepare<null, [number, number]>("DELETE FROM scheduled_posts WHERE id = ? AND bot_id = ?");
const markSentStmt = db.prepare<null, [number, number]>("UPDATE scheduled_posts SET sent_at = ? WHERE id = ?");
const disableStmt = db.prepare<null, [number]>("UPDATE scheduled_posts SET enabled = 0 WHERE id = ?");
const listPendingStmt = db.prepare<ScheduledPostRow, []>("SELECT * FROM scheduled_posts WHERE enabled = 1 AND sent_at IS NULL");

export function listScheduledPosts(botId: number): ScheduledPost[] {
	return listStmt.all(botId).map(fromRow);
}

export function getScheduledPost(botId: number, id: number): ScheduledPost | undefined {
	const row = getStmt.get(botId, id);
	return row ? fromRow(row) : undefined;
}

export function createScheduledPost(botId: number, input: ScheduledPostInput): ScheduledPost {
	assertScheduledPostInput(input);
	const row = insertStmt.get(botId, input.surface, input.targetMid, input.text, input.runAt, input.enabled ? 1 : 0, Date.now());
	return fromRow(row!);
}

export function updateScheduledPost(botId: number, id: number, input: ScheduledPostInput): boolean {
	assertScheduledPostInput(input);
	const result = updateStmt.run(input.surface, input.targetMid, input.text, input.runAt, input.enabled ? 1 : 0, id, botId);
	return result.changes > 0;
}

export function deleteScheduledPost(botId: number, id: number): boolean {
	return deleteStmt.run(id, botId).changes > 0;
}

/** Records that a post's send actually went out. */
export function markScheduledPostSent(id: number, sentAt: number): void {
	markSentStmt.run(sentAt, id);
}

/** Stops a post from firing again without deleting its history (offline bot, dropped send, ...). */
export function disableScheduledPost(id: number): void {
	disableStmt.run(id);
}

/** Every post across every bot that still needs a timer armed for it — used to rebuild the schedule after a restart. */
export function listAllPendingScheduledPosts(): ScheduledPost[] {
	return listPendingStmt.all().map(fromRow);
}
