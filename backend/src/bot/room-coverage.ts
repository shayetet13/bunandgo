/**
 * How many of each user's bots are actual members of which OpenChat.
 *
 * Exists so an admin can see, without SSH, which user is worth telling
 * "go ask that room's admin for another seat" — a user already sitting at
 * the room's own bot cap gets no benefit from a bigger `bot_quota` until
 * the *room* admits another one (see MAX_SQUARE_CHATS_PER_BOT in
 * chat-access.ts for the reverse constraint, the bot's own room cap).
 *
 * Pure read of `chats`/`bots`; nothing here is tracked or written anywhere
 * new — a bot's membership already shows up in `chats` the moment it syncs.
 */
import { db } from "../db/sqlite.ts";

export interface RoomCoverageRoom {
	mid: string;
	botCount: number;
	bots: Array<{ botId: number; name: string; slot: number }>;
}

export interface RoomCoverageUser {
	userId: number;
	username: string;
	rooms: RoomCoverageRoom[];
}

const rowsStmt = db.prepare<{ user_id: number; username: string; mid: string; bot_id: number; name: string; slot: number }, []>(
	`SELECT u.id AS user_id, u.username, c.mid, b.id AS bot_id, b.name, b.slot
	 FROM chats c
	 JOIN bots b ON b.id = c.bot_id
	 JOIN users u ON u.id = b.owner_user_id
	 WHERE c.surface = 'square' AND c.enabled = 1
	 ORDER BY u.username ASC, c.mid ASC, b.slot ASC`,
);

/** One row per (user, room), each listing every bot of that user's in it. */
export function roomCoverageReport(): RoomCoverageUser[] {
	const users = new Map<number, RoomCoverageUser>();
	for (const row of rowsStmt.all()) {
		let user = users.get(row.user_id);
		if (!user) {
			user = { userId: row.user_id, username: row.username, rooms: [] };
			users.set(row.user_id, user);
		}
		let room = user.rooms.find((r) => r.mid === row.mid);
		if (!room) {
			room = { mid: row.mid, botCount: 0, bots: [] };
			user.rooms.push(room);
		}
		room.bots.push({ botId: row.bot_id, name: row.name, slot: row.slot });
		room.botCount++;
	}
	return [...users.values()];
}
