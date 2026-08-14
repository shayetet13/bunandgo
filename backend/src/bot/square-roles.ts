import type { Client } from "../linejs-core/client/mod.ts";
import type { SquareMemberRole } from "../linejs-core/types/line_types.ts";
import { logBotEvent } from "./bot-events.ts";
import { recordAnomaly } from "./anomalies.ts";

export interface SquareMemberInfo {
	mid: string;
	displayName: string;
	role: SquareMemberRole;
}

/**
 * ADMIN/CO_ADMIN membership per OpenChat, keyed by bot then square chat mid.
 *
 * In-memory only, rebuilt on every connect (see `resolveSquareMemberRoles`,
 * called from `refreshChatsCache`) rather than persisted: it is a live view
 * of LINE's own role assignment, which can change between sessions, and
 * refetching at connect time is free relative to the rest of that sequence.
 * The one thing that must never happen is fetching this per incoming
 * message — the "ตอบเฉพาะ admin" gate in incoming-message-policy.ts reads
 * this cache, which keeps that check a single Map lookup.
 */
const rolesByBot = new Map<number, Map<string, Map<string, SquareMemberInfo>>>();

const CHAT_MEMBERS_PAGE_SIZE = 200;

// The wire value is the raw thrift enum number (1/2/10); the string names in
// LINETypes.SquareMemberRole exist only as a convenience type for building
// outgoing requests, never as what a decoded response actually contains. Both
// are checked here so this stays correct regardless of which the underlying
// library hands back.
export function isAdminRole(role: SquareMemberRole): boolean {
	return role === "ADMIN" || role === 1 || role === "CO_ADMIN" || role === 2;
}

/**
 * Bulk-fetches every member's role for the given OpenChats and caches them.
 * Runs during connect, never on the reply hot path.
 *
 * A chat that fails to resolve keeps whatever was cached for it before
 * (nothing, on a first connect) rather than the whole login failing over
 * one OpenChat — same tradeoff as `resolveSquareSelfMids`. Members with no
 * resolved role are simply absent from the cache, and `isSquareAdmin`
 * treats an absent entry as non-admin: the safe default for a switch whose
 * entire purpose is exclusivity.
 */
export async function resolveSquareMemberRoles(client: Client, botId: number, squareChatMids: string[]): Promise<void> {
	await Promise.all(squareChatMids.map(async (squareChatMid) => {
		const members = new Map<string, SquareMemberInfo>();
		try {
			let continuationToken = "";
			do {
				const response = await client.base.square.getSquareChatMembers({
					squareChatMid,
					continuationToken,
					limit: CHAT_MEMBERS_PAGE_SIZE,
				});
				for (const member of response.squareChatMembers) {
					members.set(member.squareMemberMid, {
						mid: member.squareMemberMid,
						displayName: member.displayName,
						role: member.role,
					});
				}
				continuationToken = response.continuationToken;
			} while (continuationToken);
		} catch (err) {
			// Previously swallowed outright. A room that silently resolves no
			// members is indistinguishable from one that genuinely has no
			// admins — and "no admins listed" is exactly what a room looks
			// like when this call is the thing being refused, which is a
			// symptom worth seeing rather than a blank badge.
			recordAnomaly({
				botId,
				kind: "members_unreadable",
				severity: "warn",
				chatMid: squareChatMid,
				detail: `ดึงรายชื่อสมาชิก/สิทธิ์ไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`,
			});
			return;
		}
		let byChat = rolesByBot.get(botId);
		if (!byChat) {
			byChat = new Map();
			rolesByBot.set(botId, byChat);
		}
		byChat.set(squareChatMid, members);
		// Who in this room can delete our messages at all. One row per room
		// per connect, and the only place that answer is ever written down.
		const admins = [...members.values()].filter((member) => isAdminRole(member.role));
		logBotEvent(
			botId,
			"square_admins",
			`ห้อง ${squareChatMid} · สมาชิก ${members.size} คน · admin/co-admin: ${
				admins.map((admin) => `${admin.displayName}[${admin.role}]`).join(", ") || "ไม่พบ"
			}`,
		);
	}));
}

/** O(1) Map lookup — safe to call from the reply hot path. */
export function isSquareAdmin(botId: number, squareChatMid: string, memberMid: string): boolean {
	const role = rolesByBot.get(botId)?.get(squareChatMid)?.get(memberMid)?.role;
	return role !== undefined && isAdminRole(role);
}

/** For the dashboard's admin badge / member list. */
export function listSquareMembers(botId: number, squareChatMid: string): SquareMemberInfo[] {
	return [...(rolesByBot.get(botId)?.get(squareChatMid)?.values() ?? [])];
}

/** Drops a bot's cached roles when its session/bot is deleted. */
export function clearSquareRoles(botId: number): void {
	rolesByBot.delete(botId);
}
