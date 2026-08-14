import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { botEvents } from "../bot/session-manager.ts";
import { getBot } from "../bot/bots.ts";
import { inWorkerScope } from "../bot/worker-scope.ts";
import { readWorkerTopology } from "../bot/worker-topology.ts";
import { CONTROL_TOKEN_HEADER, hasValidControlToken } from "./worker-proxy.ts";
import type { LatencySample } from "../metrics/latency.ts";
import type { FastPathSample } from "../metrics/fast-path.ts";

export const FORWARDED_EVENTS = [
	"qr",
	"pincode",
	"ready",
	"message_in",
	"send_result",
	"send_dropped",
	"fast_path",
	"bot_error",
	"chats_updated",
	"bot_status",
	"start_declined",
] as const;

export type ForwardedEventName = typeof FORWARDED_EVENTS[number];
const FORWARDED_EVENT_SET = new Set<string>(FORWARDED_EVENTS);

export function eventBotId(data: unknown): number | undefined {
	if (!data || typeof data !== "object") return undefined;
	const direct = (data as { botId?: unknown }).botId;
	if (typeof direct === "number") return direct;
	const last = (data as { last?: { botId?: unknown } }).last;
	return typeof last?.botId === "number" ? last.botId : undefined;
}

interface RelayedEvent {
	id: string;
	type: ForwardedEventName;
	data: unknown;
}

interface RelayEnvelope {
	workerId: string;
	events: RelayedEvent[];
}

export const workerEventsRoute = new Hono();
const SEEN_EVENT_LIMIT = 5_000;
const seenEventIds = new Set<string>();
const seenEventOrder: string[] = [];
const REMOTE_LATENCY_LIMIT = 500;
const REMOTE_FAST_PATH_LIMIT = 1_000;
const remoteLatency: LatencySample[] = [];
const remoteFastPath: FastPathSample[] = [];
const lastReceivedAtByWorker = new Map<string, number>();

function rememberEvent(id: string): boolean {
	if (seenEventIds.has(id)) return false;
	seenEventIds.add(id);
	seenEventOrder.push(id);
	if (seenEventOrder.length > SEEN_EVENT_LIMIT) {
		seenEventIds.delete(seenEventOrder.shift()!);
	}
	return true;
}

function appendBounded<T>(target: T[], value: T, limit: number): void {
	target.push(value);
	if (target.length > limit) target.splice(0, target.length - limit);
}

function captureRemoteMetric(event: RelayedEvent): void {
	if (!event.data || typeof event.data !== "object") return;
	const last = (event.data as { last?: unknown }).last;
	if (!last || typeof last !== "object") return;
	if (event.type === "send_result") {
		const sample = last as Partial<LatencySample>;
		if (typeof sample.botId === "number" && typeof sample.ts === "number" && typeof sample.latencyMs === "number") {
			appendBounded(remoteLatency, sample as LatencySample, REMOTE_LATENCY_LIMIT);
		}
	} else if (event.type === "fast_path") {
		const sample = last as Partial<FastPathSample>;
		if (typeof sample.botId === "number" && typeof sample.ts === "number" && typeof sample.internalMs === "number") {
			appendBounded(remoteFastPath, sample as FastPathSample, REMOTE_FAST_PATH_LIMIT);
		}
	}
}

export function relayedLatencySamples(limit: number): LatencySample[] {
	return remoteLatency.slice(-limit);
}

export function relayedFastPathSamples(limit: number): FastPathSample[] {
	return remoteFastPath.slice(-limit);
}

workerEventsRoute.post("/", async (c) => {
	const topology = readWorkerTopology();
	if (topology.ownerRoutes.size === 0 || !hasValidControlToken(c)) {
		return c.json({ error: "forbidden" }, 403);
	}
	const envelope = await c.req.json().catch(() => undefined) as Partial<RelayEnvelope> | undefined;
	if (!envelope || typeof envelope.workerId !== "string" || !Array.isArray(envelope.events) || envelope.events.length > 100) {
		return c.json({ error: "invalid event batch" }, 400);
	}
	let accepted = 0;
	for (const event of envelope.events) {
		if (!event || typeof event.id !== "string" || event.id.length < 8 || event.id.length > 100 || !FORWARDED_EVENT_SET.has(event.type)) continue;
		const botId = eventBotId(event.data);
		if (botId === undefined) continue;
		const bot = getBot(botId);
		// The control plane accepts only events for an owner it deliberately
		// routed away. Local-owner events are already on this EventEmitter.
		if (!bot || bot.ownerUserId === null || inWorkerScope(bot.ownerUserId) || !topology.ownerRoutes.has(bot.ownerUserId)) continue;
		if (!rememberEvent(event.id)) continue;
		captureRemoteMetric(event);
		botEvents.emit(event.type, event.data);
		accepted++;
	}
	lastReceivedAtByWorker.set(envelope.workerId, Date.now());
	return c.json({ accepted }, 202);
});

const MAX_QUEUE = 1_000;
const BATCH_SIZE = 50;
const queue: RelayedEvent[] = [];
let relayStarted = false;
let flushing = false;
let flushScheduled = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let lastFailureLogAt = 0;
let relayStartedAt = 0;
let lastRelaySuccessAt: number | undefined;
let lastRelayFailureAt: number | undefined;
const relayInstanceId = randomBytes(8).toString("hex");
let relaySequence = 0;

function makeRoomForCriticalEvent(): void {
	if (queue.length < MAX_QUEUE) return;
	const expendable = queue.findIndex((event) =>
		event.type === "send_result" || event.type === "fast_path" || event.type === "message_in"
	);
	queue.splice(expendable >= 0 ? expendable : 0, 1);
}

function scheduleFlush(delayMs = 0): void {
	if (flushing || flushScheduled || retryTimer) return;
	if (delayMs > 0) {
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			void flushQueue();
		}, delayMs);
		retryTimer.unref?.();
		return;
	}
	flushScheduled = true;
	setImmediate(() => {
		flushScheduled = false;
		void flushQueue();
	});
}

async function flushQueue(): Promise<void> {
	if (flushing || queue.length === 0) return;
	const topology = readWorkerTopology();
	if (!topology.controlPlaneUrl || !topology.controlPlaneToken) return;
	flushing = true;
	const batch = queue.splice(0, BATCH_SIZE);
	const endpoint = new URL("/internal/worker-events", topology.controlPlaneUrl);
	try {
		let body: string;
		try {
			body = JSON.stringify({ workerId: topology.workerId, events: batch } satisfies RelayEnvelope);
		} catch {
			// Protocol objects should be plain JSON, but a future event may carry
			// a cycle. Drop only the unserializable entries so one bad diagnostic
			// cannot permanently block QR/status events queued behind it.
			const serializable = batch.filter((event) => {
				try {
					JSON.stringify(event);
					return true;
				} catch {
					return false;
				}
			});
			if (serializable.length === 0) {
				console.error("worker event relay dropped an unserializable batch");
				flushing = false;
				if (queue.length > 0) scheduleFlush();
				return;
			}
			body = JSON.stringify({ workerId: topology.workerId, events: serializable } satisfies RelayEnvelope);
		}
		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[CONTROL_TOKEN_HEADER]: topology.controlPlaneToken,
			},
			body,
			signal: AbortSignal.timeout(3_000),
		});
		if (!response.ok) throw new Error(`control plane responded ${response.status}`);
		lastRelaySuccessAt = Date.now();
	} catch (error) {
		queue.unshift(...batch);
		if (queue.length > MAX_QUEUE) queue.length = MAX_QUEUE;
		const now = Date.now();
		lastRelayFailureAt = now;
		// During an atomic two-worker restart the shard can listen a few
		// milliseconds before the primary has bound its port. The queue already
		// retries and preserves every event, so that expected startup race is not
		// an operational error. Log only if the control plane remains unavailable
		// beyond the grace period; genuine outages still repeat every 30 seconds.
		if (now - relayStartedAt >= 5_000 && now - lastFailureLogAt >= 30_000) {
			lastFailureLogAt = now;
			console.error("worker event relay unavailable:", error instanceof Error ? error.message : error);
		}
		flushing = false;
		scheduleFlush(1_000);
		return;
	}
	flushing = false;
	if (queue.length > 0) scheduleFlush();
}

export function workerEventRelayDiagnostics(): {
	role: "control-plane" | "shard" | "standalone";
	queued: number;
	lastRelaySuccessAt?: number;
	lastRelayFailureAt?: number;
	lastReceivedAtByWorker: Record<string, number>;
} {
	const topology = readWorkerTopology();
	return {
		role: topology.controlPlaneUrl ? "shard" : topology.ownerRoutes.size > 0 ? "control-plane" : "standalone",
		queued: queue.length,
		lastRelaySuccessAt,
		lastRelayFailureAt,
		lastReceivedAtByWorker: Object.fromEntries(lastReceivedAtByWorker),
	};
}

/**
 * A shard enqueues events synchronously but serializes and sends them on a
 * later turn, keeping HTTP/JSON work out of the reply hot path.
 */
export function startWorkerEventRelay(): void {
	const topology = readWorkerTopology();
	if (relayStarted || !topology.controlPlaneUrl) return;
	relayStarted = true;
	relayStartedAt = Date.now();
	for (const type of FORWARDED_EVENTS) {
		botEvents.on(type, (data: unknown) => {
			makeRoomForCriticalEvent();
			queue.push({ id: `${relayInstanceId}:${++relaySequence}`, type, data });
			scheduleFlush();
		});
	}
}
