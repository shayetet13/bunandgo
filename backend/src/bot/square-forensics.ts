/**
 * Passive post-send forensics for OpenChat replies.
 *
 * This module deliberately performs no LINE requests. It watches the same
 * Square events the existing push/room pollers already received, retains a
 * small in-memory timeline, and writes checkpoints only after the reply has
 * completed. Consequently it cannot contend with either the send lane or the
 * poll lane while a reply is racing.
 */
import type { SquareEvent, SquareMessageState } from "../linejs-core/types/line_types.ts";
import { logBotEvent } from "./bot-events.ts";
import { toLineEpochMs } from "./inbound-delay.ts";

export type SquareForensicSource = "push" | "normal-poll" | "dedicated-poll";
export type SquareForensicPresence = "visible" | "destroyed" | "missing_after_later_event" | "pending";

interface ObservedMessage {
	messageId: string;
	fromMid: string;
	text: string;
	lineCreatedTime?: number;
	state?: SquareMessageState;
	eventType: string;
	source: SquareForensicSource;
	seenAt: number;
}

interface RoomEvidence {
	messages: ObservedMessage[];
	byId: Map<string, ObservedMessage>;
	destroyedAt: Map<string, number>;
}

export interface SquareForensicSnapshot {
	checkpointMs: number;
	messageId: string;
	acceptedState?: SquareMessageState;
	acceptedLineCreatedTime?: number;
	presence: SquareForensicPresence;
	observedState?: SquareMessageState;
	observedSource?: SquareForensicSource;
	observedAt?: number;
	destroyedAt?: number;
	/** Events around the reply, in LINE server order, kept compact for logs. */
	timeline: Array<{
		messageId: string;
		fromMid: string;
		text: string;
		lineCreatedTime?: number;
		state?: SquareMessageState;
		eventType: string;
		source: SquareForensicSource;
	}>;
}

export interface ArmSquareReplyForensicsOptions {
	botId: number;
	squareChatMid: string;
	messageId: string;
	acceptedState?: SquareMessageState;
	acceptedLineCreatedTime?: number;
	onFinal?: (snapshot: SquareForensicSnapshot) => void;
}

const MAX_MESSAGES_PER_ROOM = 200;
const TIMELINE_LIMIT = 12;
// The final point is the only one used by the visibility/retry policy. The
// old three-point trace wrote and logged three JSON records for every normal
// reply, so busy rooms steadily competed with the worker through SQLite and
// journald without producing actionable evidence.
const FINAL_CHECKPOINT_MS = 2_000;
const rooms = new Map<string, RoomEvidence>();
const botGenerations = new Map<number, number>();

function roomKey(botId: number, squareChatMid: string): string {
	return `${botId}\0${squareChatMid}`;
}

function roomEvidence(botId: number, squareChatMid: string): RoomEvidence {
	const key = roomKey(botId, squareChatMid);
	let room = rooms.get(key);
	if (!room) {
		room = { messages: [], byId: new Map(), destroyedAt: new Map() };
		rooms.set(key, room);
	}
	return room;
}

function extractMessage(event: SquareEvent): { squareChatMid: string; message: ObservedMessage } | undefined {
	const payload = event.payload as unknown as Record<string, unknown>;
	for (const value of Object.values(payload)) {
		if (!value || typeof value !== "object") continue;
		const entry = value as {
			squareChatMid?: string;
			squareMessage?: {
				message?: { id?: string; from?: string; to?: string; text?: string; createdTime?: unknown };
				state?: SquareMessageState;
			};
		};
		const raw = entry.squareMessage?.message;
		if (!raw?.id) continue;
		const squareChatMid = entry.squareChatMid ?? raw.to;
		if (!squareChatMid) continue;
		return {
			squareChatMid,
			message: {
				messageId: raw.id,
				fromMid: raw.from ?? "",
				text: raw.text ?? "",
				lineCreatedTime: toLineEpochMs(raw.createdTime),
				state: entry.squareMessage?.state,
				eventType: String(event.type),
				source: "push",
				seenAt: Date.now(),
			},
		};
	}
	return undefined;
}

/** Records one already-received event. There is no I/O in this function. */
export function observeSquareForensicEvent(
	botId: number,
	event: SquareEvent,
	source: SquareForensicSource,
	now = Date.now(),
): void {
	const destroyed = event.payload.notifiedDestroyMessage;
	if (destroyed?.squareChatMid && destroyed.messageId) {
		roomEvidence(botId, destroyed.squareChatMid).destroyedAt.set(destroyed.messageId, now);
	}

	const extracted = extractMessage(event);
	if (!extracted) return;
	const room = roomEvidence(botId, extracted.squareChatMid);
	const existing = room.byId.get(extracted.message.messageId);
	if (existing) return; // The push/poll race delivered the same event twice.
	const message = { ...extracted.message, source, seenAt: now };
	room.byId.set(message.messageId, message);
	room.messages.push(message);
	while (room.messages.length > MAX_MESSAGES_PER_ROOM) {
		const evicted = room.messages.shift();
		if (evicted && room.byId.get(evicted.messageId) === evicted) room.byId.delete(evicted.messageId);
	}
}

function buildSnapshot(
	options: ArmSquareReplyForensicsOptions,
	checkpointMs: number,
	acceptedAt: number,
): SquareForensicSnapshot {
	const room = rooms.get(roomKey(options.botId, options.squareChatMid));
	const observed = room?.byId.get(options.messageId);
	const destroyedAt = room?.destroyedAt.get(options.messageId);
	const laterEventSeen = room?.messages.some((message) => {
		if (message.messageId === options.messageId) return false;
		if (options.acceptedLineCreatedTime !== undefined && message.lineCreatedTime !== undefined) {
			return message.lineCreatedTime > options.acceptedLineCreatedTime;
		}
		return message.seenAt > acceptedAt;
	}) ?? false;
	const presence: SquareForensicPresence = destroyedAt !== undefined
		? "destroyed"
		: observed
		? "visible"
		: laterEventSeen
		? "missing_after_later_event"
		: "pending";

	const lower = (options.acceptedLineCreatedTime ?? acceptedAt) - 1_000;
	const upper = (options.acceptedLineCreatedTime ?? acceptedAt) + Math.max(checkpointMs, 2_500);
	const timeline = (room?.messages ?? [])
		.filter((message) => {
			const stamp = message.lineCreatedTime ?? message.seenAt;
			return stamp >= lower && stamp <= upper;
		})
		.sort((a, b) => (a.lineCreatedTime ?? a.seenAt) - (b.lineCreatedTime ?? b.seenAt))
		.slice(-TIMELINE_LIMIT)
		.map(({ messageId, fromMid, text, lineCreatedTime, state, eventType, source }) => ({
			messageId,
			fromMid,
			text: text.slice(0, 80),
			lineCreatedTime,
			state,
			eventType,
			source,
		}));

	return {
		checkpointMs,
		messageId: options.messageId,
		acceptedState: options.acceptedState,
		acceptedLineCreatedTime: options.acceptedLineCreatedTime,
		presence,
		observedState: observed?.state,
		observedSource: observed?.source,
		observedAt: observed?.seenAt,
		destroyedAt,
		timeline,
	};
}

/**
 * Schedules one passive verification after an already-completed send.
 * It only records an exceptional result; normal visible/pending replies do
 * not create a database write or a journal line.
 */
export function armSquareReplyForensics(options: ArmSquareReplyForensicsOptions): void {
	const acceptedAt = Date.now();
	const generation = botGenerations.get(options.botId) ?? 0;
	const timer = setTimeout(() => {
		if ((botGenerations.get(options.botId) ?? 0) !== generation) return;
		const snapshot = buildSnapshot(options, FINAL_CHECKPOINT_MS, acceptedAt);
		if (snapshot.presence === "destroyed" || snapshot.presence === "missing_after_later_event") {
			const detail = JSON.stringify(snapshot);
			logBotEvent(options.botId, "square_forensic", detail);
			console.warn(`[bot ${options.botId}] [SQ_FORENSIC] ${detail}`);
		}
		options.onFinal?.(snapshot);
	}, FINAL_CHECKPOINT_MS);
	timer.unref?.();
}

/** Exposed for focused tests and read-only diagnostics. */
export function getSquareForensicSnapshot(
	options: ArmSquareReplyForensicsOptions,
	checkpointMs = 2_000,
	acceptedAt = Date.now() - checkpointMs,
): SquareForensicSnapshot {
	return buildSnapshot(options, checkpointMs, acceptedAt);
}

/** Drops RAM evidence and invalidates pending timers for a stopped bot. */
export function clearSquareForensics(botId: number): void {
	botGenerations.set(botId, (botGenerations.get(botId) ?? 0) + 1);
	for (const key of rooms.keys()) {
		if (key.startsWith(`${botId}\0`)) rooms.delete(key);
	}
}
