import type { FeedItem, LatencyBreakdown, LatencySample } from "./types.ts";

/** How long after a message another one still counts as answering it. */
const ANSWER_WINDOW_MS = 15_000;

/**
 * Times every incoming message against the one before it in the same room,
 * using LINE's shared server timestamp.
 */
export function measureAnswers(items: FeedItem[]): Map<string, number> {
	const answers = new Map<string, number>();
	const lastByRoom = new Map<string, number>();
	for (const item of [...items].sort((a, b) => a.data.ts - b.data.ts)) {
		if (item.kind !== "in") continue;
		const room = item.data.targetMid;
		const createdTime = item.data.createdTime;
		if (createdTime === undefined) continue;
		const previous = lastByRoom.get(room);
		if (previous !== undefined && createdTime > previous && createdTime - previous <= ANSWER_WINDOW_MS) {
			answers.set(item.id, createdTime - previous);
		}
		lastByRoom.set(room, createdTime);
	}
	return answers;
}

export const BUDGET = {
	line: [40, 80],
	code: [6, 15],
	protocol: [4, 10],
	transport: [2, 5],
	go: [1, 3],
} as const;

export type Budget = readonly [number, number];

/** Adds the visible, mutually-exclusive phases; CODE is a subtotal only. */
export function sumLatencyBreakdown(b: LatencyBreakdown): { codeMs: number; totalMs: number } {
	const codeMs =
		b.decryptMs + b.matchMs + b.limiterMs + (b.routingMs ?? 0) + b.protocolPrepMs + b.relayEncodeMs + b.goPrepMs + b.relayAndParseMs;
	return { codeMs, totalMs: b.lineMs + codeMs };
}

/**
 * The most recent sample carrying both LINE stamps, so trigger-to-reply can
 * be read straight off LINE's own clock at both ends — no join, no drift
 * from our own instrumentation or from the clock offset between our server
 * and LINE's. Older or in-flight samples (test sends, or ones from before
 * triggerCreatedTime existed) simply lack one of the two fields and are
 * skipped rather than shown as a misleading zero.
 */
export function latestTriggerReplyMs(samples: readonly LatencySample[]): number | undefined {
	for (let i = samples.length - 1; i >= 0; i--) {
		const sample = samples[i]!;
		if (sample.lineCreatedTime !== undefined && sample.triggerCreatedTime !== undefined) {
			return sample.lineCreatedTime - sample.triggerCreatedTime;
		}
	}
	return undefined;
}

export function toneForAnswer(ms: number): string {
	if (ms <= 100) return "chip--go";
	if (ms <= 500) return "chip--warn";
	return "chip--bad";
}

export function toneFor(value: number, [good, warn]: Budget): string {
	if (value <= good) return "var(--signal-go)";
	if (value <= warn) return "var(--signal-warn)";
	return "var(--signal-bad)";
}
