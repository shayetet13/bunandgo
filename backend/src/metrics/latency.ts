import { EventEmitter } from "node:events";
import type { Surface } from "../db/schema.ts";
import { enqueueLatencyWrite } from "../db/write-behind.ts";

const RING_SIZE = 500;

export interface LatencySample {
	botId: number;
	ts: number;
	surface: Surface;
	targetMid: string | null;
	latencyMs: number;
	ok: boolean;
	source: "test" | "auto";
	textPreview: string | null;
	/**
	 * LINE's own stamp for the reply we sent. Comparable against the stamp
	 * on any other message in the room — including a rival bot's — which is
	 * what makes "who was actually first" answerable rather than argued.
	 */
	lineCreatedTime?: number;
	breakdown?: LatencyBreakdown;
}

export interface LatencyBreakdown {
	lineMs: number;
	codeMs: number;
	/**
	 * How late LINE handed us the trigger, before any of the rest started.
	 * Undefined when there was no inbound message or no server timestamp.
	 */
	inboundMs?: number;
	decryptMs: number;
	matchMs: number;
	limiterMs: number;
	/** App routing/guard work before RequestClient begins protocol encoding. */
	routingMs: number;
	protocolPrepMs: number;
	relayEncodeMs: number;
	goPrepMs: number;
	relayAndParseMs: number;
	upstreamCalls: number;
}

/**
 * Adds only mutually-exclusive phases. `codeMs` is intentionally excluded:
 * it is the subtotal produced by this function, not another phase to add.
 */
export function sumLatencyBreakdown(
	breakdown: Omit<LatencyBreakdown, "codeMs" | "inboundMs" | "upstreamCalls">,
): { codeMs: number; totalMs: number } {
	const codeMs =
		breakdown.decryptMs +
		breakdown.matchMs +
		breakdown.limiterMs +
		breakdown.routingMs +
		breakdown.protocolPrepMs +
		breakdown.relayEncodeMs +
		breakdown.goPrepMs +
		breakdown.relayAndParseMs;
	return { codeMs, totalMs: breakdown.lineMs + codeMs };
}

export interface LatencySnapshot {
	p50: number;
	p95: number;
	p99: number;
	okRate: number;
	count: number;
	windowSize: number;
	last: LatencySample;
}

function percentile(sortedAsc: number[], p: number): number {
	if (sortedAsc.length === 0) return 0;
	const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
	return sortedAsc[idx]!;
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

/**
 * In-memory ring buffer (last RING_SIZE sends) plus write-behind SQLite
 * history. The dedicated writer thread keeps durability work off the bot's
 * event loop. P50/P95/P99 are still available after every completed send.
 */
class LatencyTracker extends EventEmitter {
	#ring: Array<LatencySample | undefined> = new Array(RING_SIZE);
	#next = 0;
	#count = 0;
	#okCount = 0;
	#sorted: number[] = [];

	#insert(sample: LatencySample): void {
		if (this.#count === RING_SIZE) {
			const evicted = this.#ring[this.#next]!;
			const at = lowerBound(this.#sorted, evicted.latencyMs);
			if (at < this.#sorted.length) this.#sorted.splice(at, 1);
			if (evicted.ok) this.#okCount--;
		} else {
			this.#count++;
		}
		this.#ring[this.#next] = sample;
		this.#next = (this.#next + 1) % RING_SIZE;
		this.#sorted.splice(lowerBound(this.#sorted, sample.latencyMs), 0, sample.latencyMs);
		if (sample.ok) this.#okCount++;
	}

	#last(): LatencySample | undefined {
		if (this.#count === 0) return undefined;
		return this.#ring[(this.#next - 1 + RING_SIZE) % RING_SIZE];
	}

	#ordered(): LatencySample[] {
		if (this.#count < RING_SIZE) {
			return this.#ring.slice(0, this.#count) as LatencySample[];
		}
		return [
			...this.#ring.slice(this.#next),
			...this.#ring.slice(0, this.#next),
		] as LatencySample[];
	}

	record(sample: LatencySample): LatencySnapshot {
		this.#insert(sample);

		enqueueLatencyWrite(sample);

		const snapshot = this.snapshot(sample);
		this.emit("sample", snapshot);
		return snapshot;
	}

	snapshot(last?: LatencySample): LatencySnapshot {
		return {
			p50: percentile(this.#sorted, 0.5),
			p95: percentile(this.#sorted, 0.95),
			p99: percentile(this.#sorted, 0.99),
			okRate: this.#count > 0 ? (this.#okCount / this.#count) * 100 : 100,
			count: this.#count,
			windowSize: RING_SIZE,
			last: last ?? this.#last()!,
		};
	}

	recent(n: number): LatencySample[] {
		return this.#ordered().slice(-n);
	}
}

export const latencyTracker = new LatencyTracker();
