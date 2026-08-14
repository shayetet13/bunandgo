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

function signature(botId: number, surface: Surface, targetMid: string, text: string): string {
	return JSON.stringify([botId, surface, targetMid, text]);
}

function messageKey(botId: number, surface: Surface, messageId: string): string {
	return `${botId}\0${surface}\0${messageId}`;
}

function evictExpired(now: number): void {
	for (const [key, reply] of pendingReplies) {
		if (reply.expiresAt <= now) pendingReplies.delete(key);
	}
	for (const [key, reply] of seenMessageIds) {
		if (reply.expiresAt <= now) seenMessageIds.delete(key);
	}
}

export function trackAutomaticReply(
	botId: number,
	surface: Surface,
	targetMid: string,
	text: string,
	now = Date.now(),
): () => void {
	evictExpired(now);
	const key = signature(botId, surface, targetMid, text);
	const token = ++nextToken;
	pendingReplies.set(key, { botId, token, expiresAt: now + ECHO_TTL_MS });
	return () => {
		if (pendingReplies.get(key)?.token === token) pendingReplies.delete(key);
	};
}

export function isAutomaticReplyEcho(
	botId: number,
	surface: Surface,
	targetMid: string,
	text: string,
	messageId: string,
	now = Date.now(),
): boolean {
	evictExpired(now);
	const idKey = messageKey(botId, surface, messageId);
	if (seenMessageIds.has(idKey)) return true;

	const pendingKey = signature(botId, surface, targetMid, text);
	const pending = pendingReplies.get(pendingKey);
	if (!pending) return false;
	pendingReplies.delete(pendingKey);
	seenMessageIds.set(idKey, { botId, expiresAt: now + ECHO_TTL_MS });
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
