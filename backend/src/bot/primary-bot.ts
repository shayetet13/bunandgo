/**
 * Which of an owner's several bots in one OpenChat actually sends the reply.
 *
 * Several bots belonging to one owner sit in the same room on purpose — see
 * reply-guard.ts — so every one of them keeps detecting at full speed. This
 * only changes who performs the *send*: routing every reply through one
 * identity means the room only ever sees one bot answer, instead of a
 * different account every time, which is what would tell that room's admin
 * these are the same operator running several accounts and cost the seat
 * that took work to get approved in the first place.
 *
 * Nothing here touches the race itself (reply-guard.ts still decides which
 * *detection* wins) — only where the winning detection's send goes.
 */
import { db } from "../db/sqlite.ts";
import type { BotStatus } from "../db/schema.ts";
import { getBot } from "./bots.ts";

export interface RoomBot {
	botId: number;
	isPrimary: boolean;
	joinedAt: number;
	status: BotStatus;
}

// Ordered by the bot account's own age (created_at, then id as a tiebreak
// for same-instant creation), not by when it joined *this* room. An owner's
// oldest bot is a stable default across every room it's ever added to;
// ordering by room join_at instead would hand the default to whichever
// sibling happened to join a given room first, a different bot per room.
const siblingsStmt = db.prepare<{ bot_id: number; is_primary: number; joined_at: number; status: BotStatus }, [string, number]>(
	`SELECT c.bot_id, c.is_primary, c.joined_at, b.status FROM chats c
	 JOIN bots b ON b.id = c.bot_id
	 WHERE c.mid = ? AND c.surface = 'square' AND c.enabled = 1 AND b.owner_user_id = ?
	 ORDER BY b.created_at ASC, b.id ASC`,
);
const clearPrimaryStmt = db.prepare<null, [number, string]>("UPDATE chats SET is_primary = 0 WHERE bot_id = ? AND mid = ?");
const setPrimaryStmt = db.prepare<null, [number, string]>("UPDATE chats SET is_primary = 1 WHERE bot_id = ? AND mid = ?");

function siblings(ownerUserId: number, mid: string): RoomBot[] {
	return siblingsStmt.all(mid, ownerUserId).map((row) => ({
		botId: row.bot_id,
		isPrimary: row.is_primary === 1,
		joinedAt: row.joined_at,
		status: row.status,
	}));
}

/**
 * Every bot the same owner has enabled in `mid`, oldest bot account first, or
 * `[]` when `botId` is unowned or the room has none of that owner's other
 * bots in it — the two cases where there is no "sibling" concept at all.
 */
export function roomBotsFor(botId: number, mid: string, knownOwnerUserId?: number | null): RoomBot[] {
	const ownerUserId = knownOwnerUserId === undefined ? getBot(botId)?.ownerUserId : knownOwnerUserId;
	if (ownerUserId === null || ownerUserId === undefined) return [];
	return siblings(ownerUserId, mid);
}

/**
 * The bot whose account should perform the send for `detectingBotId`'s
 * catch in `mid`.
 *
 * Returns `undefined` for "just send from your own client" — the normal
 * case, and the only one for an unowned bot or a room with no siblings in
 * it. Only returns a *different* bot id when a handoff actually changes
 * anything.
 *
 * Skips a designated primary that is not `online`: session-manager.ts
 * already has a last-resort fallback for this (a dead client at handoff
 * time sends as the detecting bot instead), but which of possibly several
 * detecting siblings that ends up being is whichever wins that message's
 * race — a different, unpredictable identity per message for as long as
 * the primary stays down. Preferring the owner's oldest *online* bot here
 * instead makes the stand-in consistent — and the same bot across every
 * room, not a different one per room — turning the session-manager fallback
 * back into the true last resort (every sibling also offline) it was meant
 * to be.
 */
export function primaryBotIdFor(detectingBotId: number, mid: string, knownOwnerUserId?: number | null): number | undefined {
	const group = roomBotsFor(detectingBotId, mid, knownOwnerUserId);
	if (group.length <= 1) return undefined;
	const explicit = group.find((bot) => bot.isPrimary);
	const online = group.filter((bot) => bot.status === "online");
	const primary = (explicit?.status === "online" ? explicit : undefined) ?? online[0] ?? explicit ?? group[0]!; // every sibling offline: keep the old behaviour, harmless since nothing can send anyway
	return primary.botId === detectingBotId ? undefined : primary.botId;
}

/**
 * Makes `botId` the answerer for `mid`, demoting every sibling. Returns
 * false when `botId` is not itself an enabled square member of `mid` — a
 * bot cannot answer a room it is not actually in.
 */
export function setPrimaryBot(botId: number, mid: string): boolean {
	const ownerUserId = getBot(botId)?.ownerUserId;
	if (ownerUserId === null || ownerUserId === undefined) return false;
	const group = siblings(ownerUserId, mid);
	if (!group.some((bot) => bot.botId === botId)) return false;

	db.transaction(() => {
		for (const bot of group) clearPrimaryStmt.run(bot.botId, mid);
		setPrimaryStmt.run(botId, mid);
	})();
	return true;
}
