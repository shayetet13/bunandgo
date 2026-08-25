import type { Client } from "../linejs-core/client/mod.ts";
import type { BotType } from "../linejs-core/types/line_types.ts";
import { logBotEvent } from "./bot-events.ts";

/**
 * Whether a 1:1 Talk counterparty is a LINE Official Account, cached per bot
 * so the reply hot path never awaits a lookup. Absent from the map means
 * "not checked yet" — callers treat that as "not an OA" for the message in
 * hand and, for a fresh mid, ask `resolveOfficialAccountStatus` to fill the
 * cache in the background for next time (see session-manager.ts's
 * handleIncoming, which mirrors fillSquareSelfMid's identical pattern for
 * Square's self-mid cache).
 */
const oaStatusByBot = new Map<number, Map<string, boolean>>();

/** Prevents two overlapping messages from the same unresolved mid firing duplicate lookups. */
const pendingLookups = new Set<string>();

const OFFICIAL_BOT_TYPES: ReadonlySet<BotType> = new Set(["OFFICIAL", 1, "LINE_AT_0", 2, "LINE_AT", 3]);

/** O(1) Map lookup — safe to call from the reply hot path. */
export function isKnownOfficialAccount(botId: number, mid: string): boolean | undefined {
	return oaStatusByBot.get(botId)?.get(mid);
}

/**
 * Resolves and caches whether `mid` is a LINE Official Account via
 * `getBuddyDetail`'s `botType`. Never called from the reply hot path.
 *
 * Left uncached on failure (network hiccup, or a mid that isn't a buddy
 * contact at all) rather than caching `false`, so the next message from
 * this mid retries instead of being stuck permanently unresolved.
 */
export async function resolveOfficialAccountStatus(client: Client, botId: number, mid: string): Promise<void> {
	const pendingKey = `${botId}\0${mid}`;
	if (pendingLookups.has(pendingKey)) return;
	pendingLookups.add(pendingKey);
	try {
		const detail = await client.base.buddy.getBuddyDetail({ buddyMid: mid });
		let byBot = oaStatusByBot.get(botId);
		if (!byBot) {
			byBot = new Map();
			oaStatusByBot.set(botId, byBot);
		}
		byBot.set(mid, OFFICIAL_BOT_TYPES.has(detail.botType));
	} catch {
		// Intentionally swallowed — see the doc comment above.
	} finally {
		pendingLookups.delete(pendingKey);
	}
}

/** Drops a bot's cached OA lookups when its session/bot is deleted. */
export function clearOfficialAccountCache(botId: number): void {
	oaStatusByBot.delete(botId);
}

export interface OfficialAccountFriend {
	mid: string;
	displayName: string;
}

/**
 * Every LINE Official Account already in the bot's friend list, independent
 * of any message history — an OA the account has added but never exchanged
 * a message with (either direction) is still returned here.
 *
 * Unlike `resolveOfficialAccountStatus`, this needs no per-mid RPC:
 * `getContactsV3` (behind `client.fetchUsers()`) already reports `userType`
 * ("USER" vs "BOT") for every friend in one bulk call, so the whole friend
 * list is classified in a single round trip. Seeds the same cache
 * `resolveOfficialAccountStatus` writes, so a reply to a bulk-discovered OA
 * never has to wait through a cold first-message lookup.
 *
 * Only confirmed OAs are cached (`true`); ordinary friends are left absent
 * rather than written as `false`, so this cache stays bounded by "OAs the
 * bot actually has," not by total friend-list size.
 */
/**
 * True when a `GetContactV3Response.userType` value means "bot/Official
 * Account" rather than "regular user". Checked loosely on purpose: the
 * generated type says this decodes to the string "BOT" or the number `2`,
 * but a thrift i64/enum field can also come back as a `bigint`, and if a
 * fallback response shape (V2/getUser — see fetchUsers()) ever omits the
 * field entirely it must not be silently treated as "definitely not an OA".
 */
function isBotUserType(userType: unknown): boolean {
	if (userType === "BOT" || userType === 2) return true;
	if (typeof userType === "bigint") return userType === 2n;
	if (typeof userType === "string") return userType.trim().toUpperCase() === "BOT";
	return false;
}

export async function fetchOfficialAccountFriends(client: Client, botId: number): Promise<OfficialAccountFriend[]> {
	const users = await client.fetchUsers();
	const found: OfficialAccountFriend[] = [];
	const sampleUserTypes: string[] = [];
	for (const user of users) {
		const userType = (user.raw as { userType?: unknown }).userType;
		if (sampleUserTypes.length < 5) sampleUserTypes.push(`${typeof userType}:${String(userType)}`);
		if (!isBotUserType(userType)) continue;
		let byBot = oaStatusByBot.get(botId);
		if (!byBot) {
			byBot = new Map();
			oaStatusByBot.set(botId, byBot);
		}
		byBot.set(user.mid, true);
		const displayName = (user.raw as { targetProfileDetail?: { profileName?: string } }).targetProfileDetail?.profileName;
		found.push({ mid: user.mid, displayName: displayName || user.mid });
	}
	// Visible in the dashboard's log tab (bot_events) so a friend list that
	// doesn't surface any OA can be told apart from "genuinely has none" vs.
	// "userType didn't decode the way this code expects" without SSH access.
	logBotEvent(
		botId,
		"oa_friends_synced",
		`เพื่อนทั้งหมด ${users.length} คน · เป็น OA ${found.length} คน` +
			(found.length === 0 && users.length > 0 ? ` · ตัวอย่าง userType ที่เจอ: ${sampleUserTypes.join(", ") || "(ไม่มี field นี้)"}` : ""),
	);
	return found;
}
