import { db } from "../db/sqlite.ts";
import type { BotRow, BotStatus } from "../db/schema.ts";
import { getUser, type AuthUser } from "../auth/users.ts";
import { invalidateRules } from "./rules.ts";
import { inWorkerScope } from "./worker-scope.ts";

export interface Bot {
	id: number;
	name: string;
	slot: number;
	device: string;
	status: BotStatus;
	ownerUserId: number | null;
	allowOwnerTesting: boolean;
	/**
	 * Past the owner's quota, so it cannot be started. Not a stored column —
	 * it is the bot's position among its owner's bots versus a number that
	 * changes without touching any bot row, so persisting it would be a copy
	 * to keep in sync for no gain.
	 */
	overQuota: boolean;
	/** The LINE account (profile.mid) locked to this bot slot, or null before its first login. */
	lockedLineMid: string | null;
	/**
	 * Display name captured together with lockedLineMid at first login — see
	 * evaluateIdLock(). Null for a bot locked before this field existed and
	 * not yet reverified (see the deploy-time sweep in session-manager.ts).
	 */
	lockedLineDisplayName: string | null;
	createdAt: number;
}

/**
 * How many of this owner's bots are older than this one. Its rank, in other
 * words — rank N means N bots came first, so it is over quota exactly when
 * N is not below the quota.
 *
 * Counted rather than derived from a list so `fromRow` cannot end up calling
 * `overQuotaBots`, which maps through `fromRow` itself.
 */
const olderSiblingCountStmt = db.prepare<{ n: number }, [number, number, number, number]>(
	"SELECT COUNT(*) AS n FROM bots WHERE owner_user_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))",
);

function isRowOverQuota(row: BotRow): boolean {
	if (row.owner_user_id === null) return false;
	const owner = getUser(row.owner_user_id);
	// Admins are uncapped, and an orphaned row has nobody to bill.
	if (!owner || owner.role === "admin") return false;
	const older = olderSiblingCountStmt.get(row.owner_user_id, row.created_at, row.created_at, row.id)?.n ?? 0;
	return older >= owner.botQuota;
}

function fromRow(row: BotRow): Bot {
	return {
		id: row.id,
		name: row.name,
		slot: row.slot,
		device: row.device,
		status: row.status,
		ownerUserId: row.owner_user_id,
		allowOwnerTesting: ownerTestingBotIds.has(row.id),
		overQuota: isRowOverQuota(row),
		lockedLineMid: row.locked_line_mid,
		lockedLineDisplayName: row.locked_line_display_name,
		createdAt: row.created_at,
	};
}

/**
 * Whether this bot's owner is excused from the one-LINE-account-per-bot
 * lock — an admin's own bots, or a user an admin has explicitly marked
 * exempt (a test account that legitimately needs to swap LINE accounts).
 * An orphaned (unowned) bot has nobody to exempt, so it stays locked.
 */
export function isIdLockExempt(bot: Bot): boolean {
	if (bot.ownerUserId === null) return false;
	const owner = getUser(bot.ownerUserId);
	return !!owner && (owner.role === "admin" || owner.exemptIdLock);
}

export type IdLockOutcome = "exempt" | "first_login" | "match" | "mismatch" | "name_mismatch";

/**
 * What should happen when `lineMid`/`displayName` just logged into `bot`.
 *
 * Pure decision, no I/O — session-manager.ts acts on the result (persisting
 * the lock on "first_login", rejecting the session on "mismatch" or
 * "name_mismatch") so this stays testable without a real LINE client.
 *
 * The name check exempts exactly one case: a bot whose lock predates this
 * field (lockedLineDisplayName still null) is never punished for a name it
 * never recorded — see the deploy-time sweep in session-manager.ts for how
 * legacy bots get a name recorded instead. Once a name IS recorded, any
 * difference from it is a name_mismatch, including the current attempt
 * reporting an empty displayName — an empty incoming name used to be read
 * as "nothing to compare" and waved through, which meant a login that
 * legitimately changed hands (mid intact, name swapped) could dodge the
 * lock simply by having a client that omits displayName on that attempt.
 * Closed deliberately, accepting that a genuine transient empty-name
 * response from LINE now also locks the bot out until an admin resets it.
 */
export function evaluateIdLock(bot: Bot, lineMid: string, displayName: string): IdLockOutcome {
	if (isIdLockExempt(bot)) return "exempt";
	if (!bot.lockedLineMid) return "first_login";
	if (bot.lockedLineMid !== lineMid) return "mismatch";
	if (bot.lockedLineDisplayName && bot.lockedLineDisplayName !== displayName) {
		return "name_mismatch";
	}
	return "match";
}

const setLockedLineMidStmt = db.prepare<null, [string, string | null, number]>(
	"UPDATE bots SET locked_line_mid = ?, locked_line_display_name = ? WHERE id = ?",
);

/** Records the LINE account (and its display name) a bot's first successful login belongs to — locked as a pair. */
export function setBotLockedLineMid(botId: number, lineMid: string, displayName: string): void {
	setLockedLineMidStmt.run(lineMid, displayName || null, botId);
}

const setLockedLineDisplayNameStmt = db.prepare<null, [string, number]>(
	"UPDATE bots SET locked_line_display_name = ? WHERE id = ?",
);

/**
 * Backfills only the display-name half of an existing mid lock — for a bot
 * that was locked before this field existed and reverified since (see the
 * deploy-time sweep and evaluateIdLock()'s "match" fallback in
 * session-manager.ts). Never used for a fresh lock; that's setBotLockedLineMid.
 */
export function setBotLockedLineDisplayName(botId: number, displayName: string): void {
	setLockedLineDisplayNameStmt.run(displayName, botId);
}

const clearLockedLineMidStmt = db.prepare<null, [number]>(
	"UPDATE bots SET locked_line_mid = NULL, locked_line_display_name = NULL WHERE id = ?",
);

/**
 * Admin recovery path for a single bot: clears its lock (both the account
 * and the display name locked alongside it) so the next successful login —
 * from any LINE account — becomes the new one, without exempting the
 * owner's other bots. For a legitimately banned/replaced LINE account, or a
 * legitimate name change; see evaluateIdLock() for the lock this undoes.
 */
export function resetBotLockedLineMid(botId: number): void {
	clearLockedLineMidStmt.run(botId);
}

const needingNameReverificationStmt = db.prepare<BotRow, []>(
	"SELECT * FROM bots WHERE locked_line_mid IS NOT NULL AND locked_line_display_name IS NULL",
);

/**
 * Bots locked before the display-name half of the lock existed: mid is set,
 * name isn't. Used once by the deploy-time sweep (session-manager.ts
 * sweepLegacyIdLockNames) to force a fresh QR scan that captures a name —
 * see evaluateIdLock()'s doc comment for why login itself doesn't punish
 * these in the meantime.
 *
 * Scoped like listBots(): each of the two shard processes runs this sweep
 * independently against the same shared database, and each must only touch
 * the bots it actually owns the runtime for (stopBot() throws otherwise).
 */
export function listBotsNeedingNameReverification(): Bot[] {
	return needingNameReverificationStmt.all().map(fromRow).filter((bot) => inWorkerScope(bot.ownerUserId));
}

const OWNER_TESTING_KEY = "allowOwnerTesting";
const ownerTestingRowsStmt = db.prepare<{ bot_id: number }, []>(
	"SELECT bot_id FROM kv WHERE key = 'allowOwnerTesting' AND value_json = 'true'",
);
const setOwnerTestingStmt = db.prepare<null, [number, string, string]>(
	"INSERT INTO kv (bot_id, key, value_json) VALUES (?, ?, ?) ON CONFLICT(bot_id, key) DO UPDATE SET value_json = excluded.value_json",
);
const ownerTestingBotIds = new Set(ownerTestingRowsStmt.all().map((row) => row.bot_id));

const listStmt = db.prepare<BotRow, []>("SELECT * FROM bots ORDER BY created_at ASC");
const listByOwnerStmt = db.prepare<BotRow, [number]>("SELECT * FROM bots WHERE owner_user_id = ? ORDER BY created_at ASC");
const getStmt = db.prepare<BotRow, [number]>("SELECT * FROM bots WHERE id = ?");
const insertStmt = db.prepare<BotRow, [string, number, string, number | null, number]>(
	"INSERT INTO bots (name, slot, device, status, owner_user_id, created_at) VALUES (?, ?, ?, 'offline', ?, ?) RETURNING *",
);
// Position in creation order, counting the row itself. `id` breaks ties so
// two bots created in the same millisecond still get distinct, stable slots.
const resequenceSlotsStmt = db.prepare<null, []>(`
	UPDATE bots SET slot = (
		SELECT COUNT(*) FROM bots AS ordered
		WHERE ordered.created_at < bots.created_at
			OR (ordered.created_at = bots.created_at AND ordered.id <= bots.id)
	)
`);

/**
 * Renumbers every bot to its position in creation order, so the slots are
 * always 1..N with no gaps.
 *
 * The dashboard labels bots `bot{slot}`, so this number is the name people
 * use for a bot out loud. It previously handed a deleted bot's slot to the
 * next bot created by anyone, which left the newest bot showing as "bot2"
 * while an older one sat at "bot4" — an order that matched neither creation
 * nor anything else visible.
 *
 * Runs after any insert or delete, and once at startup so a table that
 * already drifted repairs itself. Writing the same values back is harmless,
 * and `slot` is display-only — nothing keys off it.
 */
export function resequenceBotSlots(): void {
	resequenceSlotsStmt.run();
}
const updateStatusStmt = db.prepare<null, [BotStatus, number]>("UPDATE bots SET status = ? WHERE id = ?");

const deleteBotStmt = db.prepare<null, [number]>("DELETE FROM bots WHERE id = ?");
const deleteKvStmt = db.prepare<null, [number]>("DELETE FROM kv WHERE bot_id = ?");
const deleteRulesStmt = db.prepare<null, [number]>("DELETE FROM rules WHERE bot_id = ?");
const deleteChatsStmt = db.prepare<null, [number]>("DELETE FROM chats WHERE bot_id = ?");
const deleteLatencyStmt = db.prepare<null, [number]>("DELETE FROM latency_samples WHERE bot_id = ?");
const deleteScheduledPostsStmt = db.prepare<null, [number]>("DELETE FROM scheduled_posts WHERE bot_id = ?");

const deleteBotCascade = db.transaction((id: number) => {
	deleteKvStmt.run(id);
	deleteRulesStmt.run(id);
	deleteChatsStmt.run(id);
	deleteLatencyStmt.run(id);
	deleteScheduledPostsStmt.run(id);
	deleteBotStmt.run(id);
	// Same transaction as the delete: the numbering must never be visible
	// with a hole in it.
	resequenceSlotsStmt.run();
});

export function deleteBot(id: number): void {
	deleteBotCascade(id);
	ownerTestingBotIds.delete(id);
	// Otherwise the compiled-rules cache entry outlives the bot for the rest
	// of the process — harmless at today's bot counts (ids are never reused)
	// but unbounded, and rules.ts already provides this for exactly this case.
	invalidateRules(id);
}

/**
 * Filtered to bots this process actually runs (see worker-scope.ts). A
 * multi-process split otherwise lists a bot the dashboard has no live
 * runtime for, so "start" would throw the moment it's clicked.
 */
export function listBots(): Bot[] {
	return listStmt.all().map(fromRow).filter((bot) => inWorkerScope(bot.ownerUserId));
}

export interface ListBotsOptions {
	/** Control-plane reads span the shared DB; runtime workers stay scoped. */
	includeAllWorkers?: boolean;
}

export function listBotsForUser(user: AuthUser, options: ListBotsOptions = {}): Bot[] {
	return (user.role === "admin" ? listStmt.all() : listByOwnerStmt.all(user.id))
		.map(fromRow)
		.filter((bot) => options.includeAllWorkers || inWorkerScope(bot.ownerUserId));
}

export function getBot(id: number): Bot | undefined {
	const row = getStmt.get(id);
	return row ? fromRow(row) : undefined;
}

export function canAccessBot(user: AuthUser, botId: number): boolean {
	const bot = getBot(botId);
	return !!bot && (user.role === "admin" || bot.ownerUserId === user.id);
}

export function listBotIdsForUser(user: AuthUser, options: ListBotsOptions = {}): number[] {
	return listBotsForUser(user, options).map((bot) => bot.id);
}

const listByOwnerOldestFirstStmt = db.prepare<BotRow, [number]>(
	"SELECT * FROM bots WHERE owner_user_id = ? ORDER BY created_at ASC, id ASC",
);

/** The longest-owned of a user's bots — the sibling with the most-settled rule set to copy from. */
export function oldestBotOwnedBy(userId: number): Bot | undefined {
	const row = listByOwnerOldestFirstStmt.get(userId);
	return row ? fromRow(row) : undefined;
}

/**
 * The bots a user is no longer paying for: everything past their quota,
 * newest first.
 *
 * Oldest kept, newest dropped. A quota that went from five back to one is a
 * subscription that lapsed, and the bot the customer has had longest is the
 * one with a scanned session and rules behind it — taking that and leaving
 * yesterday's empty one would be exactly backwards.
 *
 * Admins are never over quota; their `bot_quota` column is ignored entirely
 * (see the create route).
 */
export function overQuotaBots(userId: number, quota: number): Bot[] {
	const owned = listByOwnerOldestFirstStmt.all(userId).map(fromRow);
	return owned.slice(Math.max(0, quota)).reverse();
}

/**
 * Whether this bot is currently past its owner's quota, and so must not run.
 *
 * Checked at every point a session could begin — the start route, the
 * confirmation that actually logs in, and the unattended resume after a
 * restart. Enforcing it only at the first would leave a stopped over-quota
 * bot to come straight back on the next deploy.
 */
export function isBotOverQuota(botId: number): boolean {
	return getBot(botId)?.overQuota ?? false;
}

// Inserted with a placeholder slot the resequence immediately replaces: the
// new row is the newest by `created_at`, so it lands at N+1.
const insertAndResequence = db.transaction((name: string, device: string, ownerUserId: number | null): BotRow => {
	const inserted = insertStmt.get(name, 0, device, ownerUserId, Date.now())!;
	resequenceSlotsStmt.run();
	return getStmt.get(inserted.id)!;
});

export function createBot(name: string, device = "DESKTOPWIN", ownerUserId: number | null = null): Bot {
	return fromRow(insertAndResequence(name, device, ownerUserId));
}

export function updateBotStatus(id: number, status: BotStatus): void {
	updateStatusStmt.run(status, id);
}

export function isOwnerTestingEnabled(id: number): boolean {
	return ownerTestingBotIds.has(id);
}

export function updateOwnerTesting(id: number, enabled: boolean): Bot | undefined {
	if (!getStmt.get(id)) return undefined;
	setOwnerTestingStmt.run(id, OWNER_TESTING_KEY, enabled ? "true" : "false");
	if (enabled) ownerTestingBotIds.add(id);
	else ownerTestingBotIds.delete(id);
	return getBot(id);
}

const resetOneStatusStmt = db.prepare<null, [number]>(
	"UPDATE bots SET status = 'offline' WHERE id = ?",
);

const previouslyRunningStmt = db.prepare<{ id: number; owner_user_id: number | null }, []>(
	"SELECT id, owner_user_id FROM bots WHERE status != 'offline'",
);

/**
 * Marks this process's bots offline, discarding statuses left behind by a
 * previous process on the same scope, and returns the bots that process had
 * running.
 *
 * `status` records what a live session was doing, but it outlives the
 * process that owned it: after a crash or restart the table still claims
 * bots are online while no session exists. Reporting a dead bot as alive
 * is the one failure a race bot cannot afford to hide — hence the reset.
 *
 * Scoped to `inWorkerScope` (see worker-scope.ts) rather than every row: a
 * second process sharing this database must never touch the status of a
 * bot another, still-running process owns — that bot is not dead, and
 * resetting it here would just make the dashboard lie about it.
 *
 * The ids are handed back because that same row is also the only record of
 * which bots a restart is expected to bring back; see
 * `resumePreviouslyRunningBots`. Read and reset together so a second caller
 * cannot claim the same list.
 */
const resetManyStatusesTxn = db.transaction((ids: number[]) => {
	for (const id of ids) resetOneStatusStmt.run(id);
});

export function resetAllBotStatuses(): number[] {
	const mine = previouslyRunningStmt.all().filter((row) => inWorkerScope(row.owner_user_id));
	const ids = mine.map((row) => row.id);
	resetManyStatusesTxn(ids);
	return ids;
}
