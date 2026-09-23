import { db } from "../db/sqlite.ts";
import type { Surface } from "../db/schema.ts";
import { FAST_SQUARE_POLL_MAX_ROOMS } from "./fast-square-poller.ts";

/**
 * Which chats a bot is allowed to auto-reply in. Off by default per chat —
 * joining a group/OpenChat no longer implies the bot may reply there; it has
 * to be explicitly enabled first. Cached in memory (mirrors the
 * `allowOwnerTesting` pattern in `bots.ts`) so the per-message check in
 * `incoming-message-policy.ts` stays a single `Set.has()` lookup.
 */
const enabledChatsByBot = new Map<number, Set<string>>();

/**
 * OpenChat-only: rooms where the bot replies solely to senders LINE reports
 * as ADMIN/CO_ADMIN (see square-roles.ts). Same caching shape and reasoning
 * as `enabledChatsByBot` — a `Set.has()` on the reply hot path, not a query.
 */
const adminOnlyChatsByBot = new Map<number, Set<string>>();

const enabledRowsStmt = db.prepare<{ bot_id: number; mid: string }, []>("SELECT bot_id, mid FROM chats WHERE enabled = 1");
for (const row of enabledRowsStmt.all()) {
	let set = enabledChatsByBot.get(row.bot_id);
	if (!set) {
		set = new Set();
		enabledChatsByBot.set(row.bot_id, set);
	}
	set.add(row.mid);
}

const adminOnlyRowsStmt = db.prepare<{ bot_id: number; mid: string }, []>("SELECT bot_id, mid FROM chats WHERE admin_only = 1");
for (const row of adminOnlyRowsStmt.all()) {
	let set = adminOnlyChatsByBot.get(row.bot_id);
	if (!set) {
		set = new Set();
		adminOnlyChatsByBot.set(row.bot_id, set);
	}
	set.add(row.mid);
}

const setEnabledStmt = db.prepare<null, [number, number, string]>("UPDATE chats SET enabled = ? WHERE bot_id = ? AND mid = ?");

/**
 * OpenChat fast-poll runs one continuous request stream per enabled room
 * against the bot's own 6-lane connection pool (see fast-square-poller.ts /
 * h2-lanes.ts) — every extra room is one more stream competing with the
 * reply for a lane. Enforced here, at the one place a room becomes enabled,
 * rather than left to whichever caller remembers the limit. Talk chats are
 * exempt: they answer over a single push connection with no per-room
 * polling, so this contention does not apply to them.
 *
 * Pinned to FAST_SQUARE_POLL_MAX_ROOMS rather than merely matching it: a
 * bot can never have more enabled square rooms than its fast-poll budget,
 * so `selectFastPollRooms` never has more candidates than it can take and
 * never has to rank one room's traffic against another's to decide who
 * gets a poller — every enabled room always does. A room that stays quiet
 * until the one message that needs to be caught fast still gets covered
 * for exactly that reason. If these two constants were free to drift apart,
 * lowering the poll budget without also lowering this one would silently
 * bring that failure mode back — see fast-poll-room.ts.
 */
export const MAX_SQUARE_CHATS_PER_BOT = FAST_SQUARE_POLL_MAX_ROOMS;

const chatSurfaceStmt = db.prepare<{ surface: Surface }, [number, string]>("SELECT surface FROM chats WHERE bot_id = ? AND mid = ?");
const enabledSquareCountStmt = db.prepare<{ n: number }, [number]>(
	"SELECT COUNT(*) AS n FROM chats WHERE bot_id = ? AND surface = 'square' AND enabled = 1",
);

const setAdminOnlyStmt = db.prepare<null, [number, number, string]>("UPDATE chats SET admin_only = ? WHERE bot_id = ? AND mid = ?");

/**
 * Per-room narrowing of "ตอบเฉพาะ admin": which specific ADMIN/CO_ADMIN
 * members the bot answers.
 *
 * An empty allowlist for a chat means every admin, which is what the
 * admin-only switch meant on its own before this existed. That is the
 * difference between "not configured" and "configured to nobody", and it
 * matters: silently answering nobody is how a room goes quiet with the
 * dashboard still showing the bot online and enabled.
 *
 * Cached in the same shape as the sets above so the hot-path check stays a
 * pair of Map/Set lookups.
 */
const adminAllowlistByBot = new Map<number, Map<string, Set<string>>>();

const adminAllowlistRowsStmt = db.prepare<{ bot_id: number; mid: string; member_mid: string }, []>(
	"SELECT bot_id, mid, member_mid FROM chat_admin_allowlist",
);
for (const row of adminAllowlistRowsStmt.all()) {
	let byChat = adminAllowlistByBot.get(row.bot_id);
	if (!byChat) {
		byChat = new Map();
		adminAllowlistByBot.set(row.bot_id, byChat);
	}
	let members = byChat.get(row.mid);
	if (!members) {
		members = new Set();
		byChat.set(row.mid, members);
	}
	members.add(row.member_mid);
}

const clearAdminAllowlistStmt = db.prepare<null, [number, string]>("DELETE FROM chat_admin_allowlist WHERE bot_id = ? AND mid = ?");
const insertAdminAllowlistStmt = db.prepare<null, [number, string, string]>(
	"INSERT OR IGNORE INTO chat_admin_allowlist (bot_id, mid, member_mid) VALUES (?, ?, ?)",
);

/** The chosen admins for a room, empty when every admin is allowed. */
export function listChatAdminAllowlist(botId: number, mid: string): string[] {
	return [...(adminAllowlistByBot.get(botId)?.get(mid) ?? [])];
}

/**
 * True when this member may trigger a reply in an admin-only room. Being an
 * admin is checked separately (square-roles.ts); this only narrows *which*
 * admins.
 */
export function isChatAdminAllowed(botId: number, mid: string, memberMid: string): boolean {
	const allowed = adminAllowlistByBot.get(botId)?.get(mid);
	return allowed === undefined || allowed.size === 0 || allowed.has(memberMid);
}

/** Replaces a room's chosen admins. An empty list restores "any admin". */
export function setChatAdminAllowlist(botId: number, mid: string, memberMids: readonly string[]): void {
	db.transaction(() => {
		clearAdminAllowlistStmt.run(botId, mid);
		for (const memberMid of memberMids) insertAdminAllowlistStmt.run(botId, mid, memberMid);
	})();

	let byChat = adminAllowlistByBot.get(botId);
	if (!byChat) {
		byChat = new Map();
		adminAllowlistByBot.set(botId, byChat);
	}
	if (memberMids.length === 0) byChat.delete(mid);
	else byChat.set(mid, new Set(memberMids));
}

export function isChatEnabled(botId: number, mid: string): boolean {
	return enabledChatsByBot.get(botId)?.has(mid) ?? false;
}

export function isChatAdminOnly(botId: number, mid: string): boolean {
	return adminOnlyChatsByBot.get(botId)?.has(mid) ?? false;
}

export type SetChatEnabledResult = "ok" | "not_found" | "room_limit";

/**
 * Turns a room on or off for a bot's auto-replies.
 *
 * "room_limit" only fires going 2->3 on `square` rooms — re-enabling an
 * already-enabled room, disabling, and every Talk room are exempt (see
 * `MAX_SQUARE_CHATS_PER_BOT`).
 */
export function setChatEnabled(botId: number, mid: string, enabled: boolean): SetChatEnabledResult {
	if (enabled && !(enabledChatsByBot.get(botId)?.has(mid) ?? false)) {
		const chat = chatSurfaceStmt.get(botId, mid);
		if (!chat) return "not_found";
		if (chat.surface === "square" && (enabledSquareCountStmt.get(botId)?.n ?? 0) >= MAX_SQUARE_CHATS_PER_BOT) {
			return "room_limit";
		}
	}

	const { changes } = setEnabledStmt.run(enabled ? 1 : 0, botId, mid);
	if (changes === 0) return "not_found";

	let set = enabledChatsByBot.get(botId);
	if (enabled) {
		if (!set) {
			set = new Set();
			enabledChatsByBot.set(botId, set);
		}
		set.add(mid);
	} else {
		set?.delete(mid);
	}
	return "ok";
}

/** Returns false if the chat isn't known for this bot (nothing to update). */
export function setChatAdminOnly(botId: number, mid: string, adminOnly: boolean): boolean {
	const { changes } = setAdminOnlyStmt.run(adminOnly ? 1 : 0, botId, mid);
	if (changes === 0) return false;

	let set = adminOnlyChatsByBot.get(botId);
	if (adminOnly) {
		if (!set) {
			set = new Set();
			adminOnlyChatsByBot.set(botId, set);
		}
		set.add(mid);
	} else {
		set?.delete(mid);
	}
	return true;
}

/** Drops a bot's in-memory chat-access sets when its session/bot is deleted. */
export function clearChatAccess(botId: number): void {
	enabledChatsByBot.delete(botId);
	adminOnlyChatsByBot.delete(botId);
	adminAllowlistByBot.delete(botId);
}
