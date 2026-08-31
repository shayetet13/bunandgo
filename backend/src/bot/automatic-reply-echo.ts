import type { Surface } from "../db/schema.ts";

const ECHO_TTL_MS = Number(process.env.AUTOMATIC_REPLY_ECHO_TTL_MS ?? 30_000);
let nextToken = 0;

interface PendingReply {
	botId: number;
	token: number;
	expiresAt: number;
}

interface SeenReply {
	botId: number;
	expiresAt: number;
}

const pendingReplies = new Map<string, PendingReply>();
const seenMessageIds = new Map<string, SeenReply>();

function signature(scopeKey: string, surface: Surface, targetMid: string, text: string): string {
	return JSON.stringify([scopeKey, surface, targetMid, text]);
}

function messageKey(scopeKey: string, surface: Surface, messageId: string): string {
	return `${scopeKey}\0${surface}\0${messageId}`;
}

function evictExpired(now: number): void {
	for (const [key, reply] of pendingReplies) {
		if (reply.expiresAt <= now) pendingReplies.delete(key);
	}
	for (const [key, reply] of seenMessageIds) {
		if (reply.expiresAt <= now) seenMessageIds.delete(key);
	}
}

/**
 * `scopeKey` groups every bot that must recognize the same reply as "ours"
 * — see session-manager.ts's `replyOwnerKey`. Several bots of one owner
 * deliberately sit in the same OpenChat (see primary-bot.ts), and a reply
 * can go out under a *different* sibling's account than the one that
 * detected the trigger. Every other sibling still sees that send as an
 * ordinary incoming message over its own connection; keying tracking by a
 * single bot id meant only the sending bot itself (or, before today, only
 * the exact same bot checking) ever recognized it as an echo — any sibling
 * whose own rules happened to match the reply text would answer it too,
 * whose reply the *other* siblings then also see, and so on. `botId` here
 * is still the actual sender, kept only for `clearAutomaticReplyEchoes`
 * (which must clear just the stopped bot's own tracked sends, not every
 * sibling's).
 */
export function trackAutomaticReply(scopeKey: string, botId: number, surface: Surface, targetMid: string, text: string, now = Date.now()): () => void {
	evictExpired(now);
	const key = signature(scopeKey, surface, targetMid, text);
	const token = ++nextToken;
	pendingReplies.set(key, { botId, token, expiresAt: now + ECHO_TTL_MS });
	return () => {
		if (pendingReplies.get(key)?.token === token) pendingReplies.delete(key);
	};
}

export function isAutomaticReplyEcho(
	scopeKey: string,
	surface: Surface,
	targetMid: string,
	text: string,
	messageId: string,
	now = Date.now(),
): boolean {
	evictExpired(now);
	const idKey = messageKey(scopeKey, surface, messageId);
	if (seenMessageIds.has(idKey)) return true;

	const pendingKey = signature(scopeKey, surface, targetMid, text);
	const pending = pendingReplies.get(pendingKey);
	if (!pending) return false;
	pendingReplies.delete(pendingKey);
	seenMessageIds.set(idKey, { botId: pending.botId, expiresAt: now + ECHO_TTL_MS });
	return true;
}

export function clearAutomaticReplyEchoes(botId: number): void {
	for (const [key, reply] of pendingReplies) {
		if (reply.botId === botId) pendingReplies.delete(key);
	}
	for (const [key, reply] of seenMessageIds) {
		if (reply.botId === botId) seenMessageIds.delete(key);
	}
}
