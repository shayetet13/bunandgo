import { resolve } from "node:path";
import { config } from "../config.ts";
import type { LatencySample } from "../metrics/latency.ts";
import type { AnomalySeverity } from "./schema.ts";

export interface BotEventEntry {
	botId: number | null;
	ts: number;
	type: string;
	message: string | null;
}

export interface UserActionEntry {
	userId: number | null;
	username: string;
	ts: number;
	action: string;
	detail: string | null;
}

export interface MessageInEntry {
	botId: number;
	ts: number;
	surface: string;
	targetMid: string | null;
	text: string | null;
	/** LINE's own stamp for this message — see schema.ts. */
	createdTime?: number;
	/** Who sent it — see schema.ts. */
	fromMid?: string;
}

export interface AnomalyEntry {
	botId: number | null;
	ts: number;
	kind: string;
	severity: AnomalySeverity;
	chatMid: string | null;
	detail: string | null;
}

export interface LaneRaceEntry {
	workerId: string;
	ts: number;
	origin: string;
	laneId: number;
	role: "send" | "poll";
	result: "star" | "banana";
	rttMs: number;
}

export type WriteBehindOperation =
	| { kind: "kv_set"; botId: number; key: string; valueJson: string }
	| { kind: "kv_delete"; botId: number; key: string }
	| { kind: "kv_clear"; botId: number }
	| { kind: "latency"; sample: LatencySample }
	| { kind: "bot_event"; entry: BotEventEntry }
	| { kind: "user_action"; entry: UserActionEntry }
	| { kind: "message_in"; entry: MessageInEntry }
	| { kind: "anomaly"; entry: AnomalyEntry }
	| { kind: "lane_race"; entry: LaneRaceEntry };

let writer: Worker | undefined;

function getWriter(): Worker {
	if (writer) return writer;
	writer = new Worker(new URL("./sqlite-writer.worker.ts", import.meta.url), {
		name: "linebot-sqlite-writer",
		// Metrics/session persistence must never be what keeps shutdown alive.
		ref: false,
	});
	writer.addEventListener("error", (event) => {
		console.error(`[sqlite-writer] ${event.message}`);
	});
	writer.postMessage({
		kind: "init",
		// Must track config.dbPath, not re-derive its own — this used to always
		// resolve to the real "data/app.db" file regardless of NODE_ENV, so
		// every test run's kv/latency/log writes landed in the actual local
		// dev database (fake usernames like "test-admin" ending up in a real
		// user_actions table is exactly that bug, not a feature).
		dbPath: config.dbPath === ":memory:" ? ":memory:" : resolve(config.dbPath),
	});
	return writer;
}

export function enqueueWrite(operation: WriteBehindOperation): void {
	getWriter().postMessage(operation);
}

export function enqueueLatencyWrite(sample: LatencySample): void {
	enqueueWrite({ kind: "latency", sample });
}

export function enqueueBotEvent(entry: BotEventEntry): void {
	enqueueWrite({ kind: "bot_event", entry });
}

export function enqueueUserAction(entry: UserActionEntry): void {
	enqueueWrite({ kind: "user_action", entry });
}

export function enqueueMessageIn(entry: MessageInEntry): void {
	enqueueWrite({ kind: "message_in", entry });
}

export function enqueueAnomaly(entry: AnomalyEntry): void {
	enqueueWrite({ kind: "anomaly", entry });
}

export function enqueueLaneRace(entry: LaneRaceEntry): void {
	enqueueWrite({ kind: "lane_race", entry });
}

