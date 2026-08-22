import { randomBytes } from "node:crypto";
import { botEvents, emitError, startBot } from "./session-manager.ts";
import { getBot } from "./bots.ts";
import { db } from "../db/sqlite.ts";
import type { StartConfirmationRow } from "../db/schema.ts";
import { inWorkerScope, WorkerScopeError } from "./worker-scope.ts";

/**
 * Gate between pressing "เริ่ม" and starting the real LINE QR login. Rows
 * live in shared SQLite because the dashboard, scanned confirmation link,
 * and owning runtime may be served by different processes after sharding.
 */
export type StartConfirmationStatus = "pending" | "accepted" | "declined";

export interface StartConfirmation {
	botId: number;
	status: StartConfirmationStatus;
	createdAt: number;
}

const TTL_MS = 10 * 60_000;
const getStmt = db.prepare<StartConfirmationRow, [string]>("SELECT * FROM start_confirmations WHERE token = ?");
const pendingForBotStmt = db.prepare<StartConfirmationRow, [number, number]>(
	"SELECT * FROM start_confirmations WHERE bot_id = ? AND status = 'pending' AND created_at > ? LIMIT 1",
);
const insertStmt = db.prepare<null, [string, number, number]>(
	"INSERT INTO start_confirmations (token, bot_id, status, created_at) VALUES (?, ?, 'pending', ?)",
);
const pruneStmt = db.prepare<null, [number]>("DELETE FROM start_confirmations WHERE status != 'pending' OR created_at <= ?");
const resolveStmt = db.prepare<null, [StartConfirmationStatus, string, number]>(
	"UPDATE start_confirmations SET status = ? WHERE token = ? AND status = 'pending' AND created_at > ?",
);
const clearBotStmt = db.prepare<null, [number]>("DELETE FROM start_confirmations WHERE bot_id = ?");

function fromRow(row: StartConfirmationRow): StartConfirmation {
	return { botId: row.bot_id, status: row.status, createdAt: row.created_at };
}

const createTransaction = db.transaction((botId: number, now: number): string => {
	const cutoff = now - TTL_MS;
	pruneStmt.run(cutoff);
	const existing = pendingForBotStmt.get(botId, cutoff);
	if (existing) return existing.token;
	const token = randomBytes(24).toString("hex");
	insertStmt.run(token, botId, now);
	return token;
});

// Double-clicking "เริ่ม" (or a second process racing it) reuses one pending
// token. The partial unique index is the final cross-process guard.
export function createStartConfirmation(botId: number): string {
	return createTransaction(botId, Date.now());
}

export function getStartConfirmation(token: string): StartConfirmation | undefined {
	const row = getStmt.get(token);
	if (!row || Date.now() - row.created_at >= TTL_MS) return undefined;
	return fromRow(row);
}

/**
 * Claims the one-shot decision atomically, then starts LINE outside the DB
 * transaction. A routing mistake fails closed before consuming the token.
 */
export async function acceptStartConfirmation(token: string): Promise<boolean> {
	const row = getStmt.get(token);
	if (!row || row.status !== "pending" || Date.now() - row.created_at >= TTL_MS) return false;
	const bot = getBot(row.bot_id);
	if (!bot || bot.status !== "offline") {
		resolveStmt.run("declined", token, Date.now() - TTL_MS);
		return false;
	}
	if (!inWorkerScope(bot.ownerUserId)) {
		throw new WorkerScopeError("ลิงก์ยืนยันนี้ต้องดำเนินการบน worker ที่ดูแลบอท");
	}
	const claimed = resolveStmt.run("accepted", token, Date.now() - TTL_MS).changes > 0;
	if (!claimed) return false;
	void startBot(row.bot_id).catch((err) => emitError(row.bot_id, err));
	return true;
}

/** Returns false if the token is unknown, expired, or already resolved. */
export function declineStartConfirmation(token: string): boolean {
	const row = getStmt.get(token);
	if (!row || Date.now() - row.created_at >= TTL_MS) return false;
	const changed = resolveStmt.run("declined", token, Date.now() - TTL_MS).changes > 0;
	if (changed) botEvents.emit("start_declined", { botId: row.bot_id });
	return changed;
}

/** Drops every confirmation for a bot being deleted. */
export function clearStartConfirmationsForBot(botId: number): void {
	clearBotStmt.run(botId);
}
