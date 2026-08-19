/**
 * Deduplicates LINE redelivery by message identity.
 *
 * A new message from the admin is always a new round even when its text is
 * identical. The same message id, however, stays claimed for a bounded TTL so
 * an out-of-order replay cannot answer again after newer messages arrived.
 */

const CLAIM_TTL_MS = Number(process.env.REPLY_CLAIM_TTL_MS ?? 10 * 60_000);
const MAX_CLAIMS = Number(process.env.REPLY_CLAIM_MAX ?? 50_000);
const SEP = "\0";

/** Map insertion order doubles as an O(1) eviction queue. */
const claims = new Map<string, { botId: number; claimedAt: number }>();

/**
 * Deduplicates the incoming message itself, not just the reply to it.
 *
 * The fast Square poller and the ordinary push connection race on purpose —
 * see fast-square-poller.ts — and `claimReply` already makes the *send*
 * exactly-once between them. But nothing gated the observation side: both
 * paths funnel into the same handler via `client.emit("square:message", …)`,
 * and everything before the reply claim (rule matching, the live-feed entry,
 * the durable `messages_in` row) ran once per delivery. A message arriving
 * over both paths logged twice; the dashboard's "record 2026-08-09" bug had
 * three near-simultaneous rows for one real "คับ", which is what a push
 * delivery plus a poller cursor boundary duplicate looks like with no guard
 * at the door. This is that guard, checked first, before any of that work
 * starts rather than only before the send.
 */
const seenIncoming = new Map<string, { botId: number; claimedAt: number }>();

function evictOneAtCapacityFrom(map: Map<string, { botId: number; claimedAt: number }>): void {
	if (map.size < MAX_CLAIMS) return;
	const oldest = map.keys().next().value;
	if (oldest !== undefined) map.delete(oldest);
}

/** Claims a raw message id once per bot+surface; a duplicate delivery returns false. */
export function claimIncomingMessage(
	botId: number,
	surface: string,
	messageId: string,
	now = performance.now(),
): boolean {
	const k = `${botId}${SEP}${surface}${SEP}${messageId}`;
	const existing = seenIncoming.get(k);
	if (existing && now - existing.claimedAt < CLAIM_TTL_MS) return false;
	if (existing) seenIncoming.delete(k);
	evictOneAtCapacityFrom(seenIncoming);
	seenIncoming.set(k, { botId, claimedAt: now });
	return true;
}

/**
 * One answer per message per owner, across every bot that owner has in the
 * room.
 *
 * Several bots belonging to the same person are deliberately put in the same
 * OpenChat: each has its own poll cycle at its own phase, so whichever one
 * happens to be mid-request when the trigger lands sees it first. That is the
 * point — but without this, all of them would then answer, and the room would
 * get the same reply four times over.
 *
 * Scoped to the owner rather than globally: two different customers' bots in
 * one room are separate operations racing each other, and one must never
 * silence the other.
 *
 * First past the post wins, with no waiting to compare candidates. The bot
 * that gets here first is the one whose poll and lanes were warmest — the
 * "hottest bot answers" outcome falls out of the race itself, and buying it
 * deliberately would cost exactly the milliseconds the extra bots were added
 * to save.
 */
const roomAnswers = new Map<string, { botId: number; claimedAt: number }>();

/**
 * `ownerKey` groups the bots that must not answer each other's messages —
 * the owning user's id, or the bot's own id when it has no owner, which
 * leaves an unowned bot racing alone.
 */
export function claimRoomAnswer(
	ownerKey: string,
	botId: number,
	chatMid: string,
	messageId: string,
	now = performance.now(),
): boolean {
	const k = `${ownerKey}${SEP}${chatMid}${SEP}${messageId}`;
	const existing = roomAnswers.get(k);
	if (existing && now - existing.claimedAt < CLAIM_TTL_MS) return false;
	if (existing) roomAnswers.delete(k);
	evictOneAtCapacityFrom(roomAnswers);
	roomAnswers.set(k, { botId, claimedAt: now });
	return true;
}

function key(
	botId: number,
	chatMid: string,
	ruleId: number,
	messageId: string,
): string {
	return `${botId}${SEP}${chatMid}${SEP}${ruleId}${SEP}${messageId}`;
}

function evictOneAtCapacity(): void {
	if (claims.size < MAX_CLAIMS) return;
	const oldest = claims.keys().next().value;
	if (oldest !== undefined) claims.delete(oldest);
}

/** Claims a message once; a different message id remains independently valid. */
export function claimReply(
	botId: number,
	chatMid: string,
	ruleId: number,
	messageId: string,
	now = performance.now(),
): boolean {
	const k = key(botId, chatMid, ruleId, messageId);
	const existing = claims.get(k);
	if (existing && now - existing.claimedAt < CLAIM_TTL_MS) return false;
	if (existing) claims.delete(k);
	// Never sweep the whole TTL queue here. A long-idle bot could otherwise
	// delete 50k entries on its first message (measured >7ms). Stale entries
	// are harmless until the same identity is checked, and capacity remains
	// bounded by evicting exactly one oldest item per new insertion.
	evictOneAtCapacity();
	claims.set(k, { botId, claimedAt: now });
	return true;
}

/** Forgets every claim owned by a stopped/deleted bot. */
export function clearBotClaims(botId: number): void {
	for (const [k, claim] of claims) {
		if (claim.botId === botId) claims.delete(k);
	}
	for (const [k, claim] of seenIncoming) {
		if (claim.botId === botId) seenIncoming.delete(k);
	}
	// A stopped bot's room claims have to go too, or a message it answered
	// just before stopping keeps its siblings silent for the rest of the TTL.
	for (const [k, claim] of roomAnswers) {
		if (claim.botId === botId) roomAnswers.delete(k);
	}
}
