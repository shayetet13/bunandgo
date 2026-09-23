/**
 * Answers an OpenChat (Square) moderator deleting our own auto-reply.
 *
 * LINE lets any ADMIN/CO_ADMIN of a Square chat destroy another member's
 * message for everyone (`NOTIFIED_DESTROY_MESSAGE`) — there is no
 * permission fight that beats that at the protocol level. What we *can* do
 * is notice the destroy immediately and fire the same reply again before
 * the room moves on, so a message that keeps getting deleted keeps coming
 * back instead of just vanishing once.
 *
 * Every sent auto-reply is tracked by its own `messageId` for a short TTL.
 * A destroy that matches a tracked id claims one resend attempt out of a
 * capped budget; anything else (a human's message, a stale id, a budget
 * already spent) is ignored.
 */

const TTL_MS = Number(process.env.REPLY_DEFENSE_TTL_MS ?? 15_000);
export const MAX_RESENDS = Number(process.env.REPLY_DEFENSE_MAX_RESENDS ?? 2);

/**
 * Invisible suffixes, cycled so no two consecutive replies with the same
 * visible text are byte-identical.
 *
 * Anything that suppresses our replies by matching them — a rival bot's
 * delete rule, or a platform-side duplicate filter — has to match on
 * *something*, and the only thing it can see is the text we send. Sending
 * the same bytes every time is the one property that makes us trivial to
 * match, and it is free to remove. Cycled rather than appended so the
 * suffix cannot grow without bound in a long-running room.
 */
const ZWSP = "​";
const ZWNJ = "‌";
const WORD_JOINER = "⁠";
const VARIANT_MARKS = ["", ZWSP, ZWNJ, WORD_JOINER, ZWSP + ZWSP, ZWSP + ZWNJ, ZWNJ + WORD_JOINER, WORD_JOINER + ZWSP];

/** How long the same reply text counts as a repeat worth varying. */
const REPEAT_WINDOW_MS = Number(process.env.REPLY_UNIQUIFY_WINDOW_MS ?? 5 * 60_000);
const UNIQUIFY_ENABLED = process.env.REPLY_UNIQUIFY !== "0";

interface TrackedReply {
	botId: number;
	text: string;
	/** 0 = the original send; counts up with each resend. */
	attempt: number;
	expiresAt: number;
}

function key(botId: number, squareChatMid: string, messageId: string): string {
	return `${botId}\0${squareChatMid}\0${messageId}`;
}

const tracked = new Map<string, TrackedReply>();

function evictExpired(now: number): void {
	for (const [k, entry] of tracked) {
		if (entry.expiresAt <= now) tracked.delete(k);
	}
}

/** Registers a just-sent auto-reply so a destroy of it can be answered. */
export function trackSentReply(botId: number, squareChatMid: string, messageId: string, text: string, attempt = 0, now = Date.now()): void {
	evictExpired(now);
	tracked.set(key(botId, squareChatMid, messageId), { botId, text, attempt, expiresAt: now + TTL_MS });
}

/**
 * Consumes the tracking entry for a destroyed message and returns what to
 * resend, if this was one of ours and its resend budget is not spent.
 */
export function claimResend(
	botId: number,
	squareChatMid: string,
	messageId: string,
	now = Date.now(),
): { text: string; attempt: number } | undefined {
	evictExpired(now);
	const k = key(botId, squareChatMid, messageId);
	const entry = tracked.get(k);
	if (!entry) return undefined;
	tracked.delete(k);
	if (entry.attempt >= MAX_RESENDS) return undefined;
	return { text: entry.text, attempt: entry.attempt + 1 };
}

/** Marks resent text so a literal-match deletion rule does not recognize it. */
export function varyText(text: string, attempt: number): string {
	return text + VARIANT_MARKS[attempt % VARIANT_MARKS.length]!;
}

/** Last reply sent per chat, for deciding when a reply is a repeat. */
const lastReplyByChat = new Map<string, { text: string; variant: number; at: number }>();

/** Records which variant's bytes are now in the room, so the next send can differ from them. */
function rememberSend(botId: number, chatMid: string, text: string, variant: number, now: number): void {
	lastReplyByChat.set(`${botId}\0${chatMid}`, { text, variant, at: now });
}

/**
 * The variant to use for `text` in this chat: one step past whatever was
 * last sent there, or 0 when this text is not a recent repeat.
 *
 * The single source of truth for "which suffix is already in the room".
 * Both the first send and any resend draw from it, which is what guarantees
 * a resend cannot reuse the bytes it is replacing (variant N+1 is never
 * variant N, and `varyText` only wraps after a full cycle of 8).
 */
function nextVariant(botId: number, chatMid: string, text: string, now: number): number {
	const previous = lastReplyByChat.get(`${botId}\0${chatMid}`);
	const isRepeat = previous !== undefined && previous.text === text && now - previous.at <= REPEAT_WINDOW_MS;
	const variant = isRepeat ? previous.variant + 1 : 0;
	rememberSend(botId, chatMid, text, variant, now);
	return variant;
}

/**
 * Returns the text to actually send for a reply.
 *
 * The first time a given text goes to a chat it is sent verbatim. Repeats
 * of that same text within the window get a different invisible suffix each
 * time, so a matcher keyed on the previous message's exact content does not
 * recognize the next one. Visible output is unchanged either way.
 */
export function uniquifyReply(botId: number, chatMid: string, text: string, now = Date.now()): string {
	// Still recorded when varying is switched off: the bytes that went to the
	// room are the bare text (variant 0), and a resend of it must know that
	// to pick something different. `resendText` does not honour this toggle.
	if (!UNIQUIFY_ENABLED) {
		rememberSend(botId, chatMid, text, 0, now);
		return text;
	}
	return varyText(text, nextVariant(botId, chatMid, text, now));
}

/**
 * The text to resend after `text`'s message was destroyed.
 *
 * Takes its variant from the same per-chat counter as `uniquifyReply`
 * rather than from the resend attempt number. Two independent counters over
 * one 8-entry `VARIANT_MARKS` array is what let a resend go out byte-identical
 * to the message that had just been deleted — uniquify variant 1 and resend
 * attempt 1 are the same suffix — so the deletion rule that matched the
 * original matched the retry too, defeating the one thing varying it is for.
 *
 * Always varies, even under `REPLY_UNIQUIFY=0`: a resend exists precisely
 * because something matched and removed the previous bytes, so repeating
 * them is the one option that is known not to work.
 */
export function resendText(botId: number, chatMid: string, text: string, now = Date.now()): string {
	return varyText(text, nextVariant(botId, chatMid, text, now));
}

/** Forgets a bot's repeat history. */
export function clearReplyVariants(botId: number): void {
	for (const key of lastReplyByChat.keys()) {
		if (key.startsWith(`${botId}\0`)) lastReplyByChat.delete(key);
	}
}

/** Drops a bot's tracked replies when its session/bot is deleted. */
export function clearTrackedReplies(botId: number): void {
	for (const [k, entry] of tracked) {
		if (entry.botId === botId) tracked.delete(k);
	}
	clearReplyVariants(botId);
}
