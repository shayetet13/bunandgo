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
 * Caps how many friends a single sync round classifies via getBuddyDetail —
 * a defensive ceiling, not a real-world expectation (the largest friend
 * list seen live so far is under 100). Protects against a pathological
 * account with thousands of friends turning a connect-time sync into
 * thousands of RPCs; anything beyond the cap is simply not classified this
 * round rather than the sync stalling connect indefinitely.
 */
const MAX_OA_SYNC_FRIENDS = 300;

/** Bounded concurrency for the getBuddyDetail fan-out below — connect-time only, never the reply hot path. */
const OA_SYNC_CONCURRENCY = 8;

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	async function worker(): Promise<void> {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			results[i] = await fn(items[i]!);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

/**
 * Every LINE Official Account already in the bot's friend list, independent
 * of any message history — an OA the account has added but never exchanged
 * a message with (either direction) is still returned here.
 *
 * `getContactsV3`'s `userType` field (the bulk, no-extra-RPC signal this
 * originally tried to use) turned out to decode as `undefined` in every
 * live response observed — confirmed via bot_events across 8 real bots
 * (0 of ~140 total friends had it populated at all, OA or not). Falls back
 * to the same per-mid `getBuddyDetail`/`botType` check
 * `resolveOfficialAccountStatus` already uses for the reactive path, fanned
 * out with bounded concurrency since this runs once per connect, not once
 * per reply. Seeds the same cache, so a reply to a bulk-discovered OA never
 * has to wait through a cold first-message lookup.
 *
 * Only confirmed OAs are cached (`true`); ordinary friends are left absent
 * rather than written as `false`, so this cache stays bounded by "OAs the
 * bot actually has," not by total friend-list size.
 */
interface ClassifyResult {
	isOfficial: boolean;
	failed: boolean;
	botType?: unknown;
	errorMessage?: string;
}

export async function fetchOfficialAccountFriends(client: Client, botId: number): Promise<OfficialAccountFriend[]> {
	const allUsers = await client.fetchUsers();
	const users = allUsers.slice(0, MAX_OA_SYNC_FRIENDS);
	const results = await mapWithConcurrency(users, OA_SYNC_CONCURRENCY, async (user): Promise<ClassifyResult> => {
		try {
			const detail = await client.base.buddy.getBuddyDetail({ buddyMid: user.mid });
			return { isOfficial: OFFICIAL_BOT_TYPES.has(detail.botType), failed: false, botType: detail.botType };
		} catch (err) {
			// Most friends aren't buddies at all — getBuddyDetail rejecting for
			// them is the expected, common case, not a failure worth surfacing
			// on its own. Still recorded (see the diagnostic log below) so a
			// sync that fails for *every* friend is distinguishable from one
			// that correctly finds zero OAs among friends who really aren't any.
			return { isOfficial: false, failed: true, errorMessage: err instanceof Error ? err.message : String(err) };
		}
	});

	const found: OfficialAccountFriend[] = [];
	let failedCount = 0;
	const botTypeSamples: string[] = [];
	const errorSamples: string[] = [];
	users.forEach((user, i) => {
		const result = results[i]!;
		if (result.failed) {
			failedCount++;
			if (errorSamples.length < 3) errorSamples.push(result.errorMessage ?? "(no message)");
		} else if (botTypeSamples.length < 5) {
			botTypeSamples.push(`${typeof result.botType}:${String(result.botType)}`);
		}
		if (!result.isOfficial) return;
		let byBot = oaStatusByBot.get(botId);
		if (!byBot) {
			byBot = new Map();
			oaStatusByBot.set(botId, byBot);
		}
		byBot.set(user.mid, true);
		const displayName = (user.raw as { targetProfileDetail?: { profileName?: string } }).targetProfileDetail?.profileName;
		found.push({ mid: user.mid, displayName: displayName || user.mid });
	});

	// Visible in the dashboard's log tab (bot_events) so a friend list that
	// doesn't surface any OA can be told apart from "genuinely has none" vs.
	// "getBuddyDetail rejected for everyone" vs. "botType decoded as
	// something this code doesn't recognize" — three different bugs that
	// would otherwise all look identical from the outside.
	logBotEvent(
		botId,
		"oa_friends_synced",
		`เพื่อนทั้งหมด ${allUsers.length} คน · ตรวจแล้ว ${users.length} คน (getBuddyDetail สำเร็จ ${users.length - failedCount}, ล้มเหลว ${failedCount}) · เป็น OA ${found.length} คน` +
			(allUsers.length > users.length ? ` · ข้าม ${allUsers.length - users.length} คน (เกินขีดจำกัด ${MAX_OA_SYNC_FRIENDS})` : "") +
			(found.length === 0 && botTypeSamples.length > 0 ? ` · ตัวอย่าง botType ที่เจอ: ${botTypeSamples.join(", ")}` : "") +
			(errorSamples.length > 0 ? ` · ตัวอย่าง error: ${errorSamples.join(" | ")}` : ""),
	);
	return found;
}
