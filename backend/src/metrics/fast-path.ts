import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import type { Surface } from "../db/schema.ts";

const RING_SIZE = 1000;

export interface FastPathTrace {
	botId: number;
	surface: Surface;
	source: "auto" | "test";
	receivedAt: number;
	/** Which inbound transport won the race for this trigger. */
	receiveSource?: "push" | "normal-poll" | "dedicated-poll";
	/**
	 * Milliseconds LINE spent getting the trigger to us, before any of the
	 * timings below started. Undefined for sends with no inbound message
	 * (manual tests) or when the message carried no server timestamp.
	 * Spans two clocks — see inbound-delay.ts.
	 */
	inboundMs?: number;
	/** LINE's stamp on the reply this trace produced, once the send returns. */
	lineCreatedTime?: number;
	decryptMs: number;
	matchMs: number;
	admissionMs: number;
	/** Actual Thrift/request construction, measured inside RequestClient. */
	protocolPrepMs: number;
	relayEncodeMs: number;
	dispatchStartedAt?: number;
	goPrepMs: number;
	upstreamCalls: number;
	upstreamMs: number;
}

export interface FastPathSample extends FastPathTrace {
	ts: number;
	internalMs: number;
	dropped: boolean;
	dropReason?: string;
}

export interface FastPathSnapshot {
	p50: number;
	p95: number;
	p99: number;
	max: number;
	count: number;
	last?: FastPathSample;
}

const context = new AsyncLocalStorage<FastPathTrace>();

export function runWithFastPath<T>(trace: FastPathTrace, fn: () => Promise<T>): Promise<T> {
	return context.run(trace, fn);
}

/** JITs AsyncLocalStorage before the first real message starts its clock. */
export async function prewarmFastPathRuntime(botId: number): Promise<void> {
	const trace: FastPathTrace = {
		botId,
		surface: "talk",
		source: "auto",
		receivedAt: performance.now(),
		decryptMs: 0,
		matchMs: 0,
		admissionMs: 0,
		protocolPrepMs: 0,
		relayEncodeMs: 0,
		goPrepMs: 0,
		upstreamCalls: 0,
		upstreamMs: 0,
	};
	await context.run(trace, async () => {
		// Exercise AsyncLocalStorage.getStore plus both mutation branches. The
		// in-RAM transport warmup otherwise returns before these functions.
		markRelayDispatch(0);
		markRelayResult(0, 0);
		await Promise.resolve();
	});
}

export function markRelayDispatch(encodeMs: number): void {
	const trace = context.getStore();
	if (!trace) return;
	trace.upstreamCalls++;
	// The internal fast path ends when the first request is ready to leave
	// Bun. A retry/fallback can happen after an entire LINE round trip; never
	// mislabel that external wait as CPU time by moving this timestamp.
	if (trace.dispatchStartedAt === undefined) {
		trace.relayEncodeMs = encodeMs;
		trace.dispatchStartedAt = performance.now();
	}
}

export function markProtocolPrep(durationMs: number): void {
	const trace = context.getStore();
	if (!trace) return;
	trace.protocolPrepMs += durationMs;
}

export function markRelayResult(goPrepMs: number, upstreamMs: number): void {
	const trace = context.getStore();
	if (!trace) return;
	if (trace.goPrepMs === 0) trace.goPrepMs = goPrepMs;
	trace.upstreamMs += upstreamMs;
}

function percentile(sorted: number[], p: number): number {
	if (!sorted.length) return 0;
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!;
}

function lowerBound(sorted: number[], value: number): number {
	let lo = 0;
	let hi = sorted.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (sorted[mid]! < value) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

class FastPathTracker extends EventEmitter {
	#ring: Array<FastPathSample | undefined> = new Array(RING_SIZE);
	#next = 0;
	#count = 0;
	#sorted: number[] = [];

	#insert(sample: FastPathSample): void {
		if (this.#count === RING_SIZE) {
			const evicted = this.#ring[this.#next];
			if (evicted && !evicted.dropped) {
				const at = lowerBound(this.#sorted, evicted.internalMs);
				if (at < this.#sorted.length) this.#sorted.splice(at, 1);
			}
		} else {
			this.#count++;
		}
		this.#ring[this.#next] = sample;
		this.#next = (this.#next + 1) % RING_SIZE;
		if (!sample.dropped) {
			this.#sorted.splice(lowerBound(this.#sorted, sample.internalMs), 0, sample.internalMs);
		}
	}

	#last(): FastPathSample | undefined {
		if (this.#count === 0) return undefined;
		return this.#ring[(this.#next - 1 + RING_SIZE) % RING_SIZE];
	}

	#ordered(): FastPathSample[] {
		if (this.#count < RING_SIZE) {
			return this.#ring.slice(0, this.#count) as FastPathSample[];
		}
		return [...this.#ring.slice(this.#next), ...this.#ring.slice(0, this.#next)] as FastPathSample[];
	}

	record(trace: FastPathTrace, dropped = false, dropReason?: string): FastPathSnapshot {
		const internalMs = dropped
			? performance.now() - trace.receivedAt
			: // Subtract only time measured inside Go's upstream round trips.
				// Everything left is owned by this application, including Bun↔Go
				// loopback, serialization, crypto and event-loop scheduling.
				Math.max(0, performance.now() - trace.receivedAt - trace.upstreamMs);
		const sample: FastPathSample = {
			...trace,
			ts: Date.now(),
			internalMs,
			dropped,
			dropReason,
		};
		this.#insert(sample);
		const snapshot = this.snapshot(sample);
		this.emit("sample", snapshot);
		return snapshot;
	}

	snapshot(last?: FastPathSample): FastPathSnapshot {
		return {
			p50: percentile(this.#sorted, 0.5),
			p95: percentile(this.#sorted, 0.95),
			p99: percentile(this.#sorted, 0.99),
			max: this.#sorted[this.#sorted.length - 1] ?? 0,
			count: this.#sorted.length,
			last: last ?? this.#last(),
		};
	}

	recent(limit: number): FastPathSample[] {
		return this.#ordered().slice(-limit);
	}
}

export const fastPathTracker = new FastPathTracker();
