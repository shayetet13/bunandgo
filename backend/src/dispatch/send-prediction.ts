import { SEND_SLOW_COOLDOWN_MS, SEND_SLOW_THRESHOLD_MS } from "./lane-speed-policy.ts";

function boundedEnv(name: string, fallback: number, min: number, max: number): number {
	const parsed = Number(process.env[name] ?? fallback);
	return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

/** Seven results react quickly while retaining enough history to expose a spike. */
export const SEND_SAMPLE_WINDOW = Math.trunc(boundedEnv("LINE_H2_SEND_SAMPLE_WINDOW", 7, 3, 31));
/**
 * A bot-specific result older than this falls back to the lane's shared prior.
 *
 * 15 minutes, not 30 seconds: real production SEND traffic on one bot/room is
 * minutes apart, so a 30s window meant the per-route predictor was effectively
 * never fresh and every selection fell back to transport PING. A lane only
 * lives ~15min before it is recycled anyway (LANE_MAX_AGE_MS), so the samples
 * cannot outlive the physical route they describe.
 */
export const SEND_ROUTE_SAMPLE_MAX_AGE_MS = boundedEnv("LINE_H2_SEND_ROUTE_SAMPLE_MAX_AGE_MS", 900_000, 1_000, 3_600_000);
/** Converts observed p95-p50 spread into a conservative completion estimate. */
export const SEND_JITTER_WEIGHT = boundedEnv("LINE_H2_SEND_JITTER_WEIGHT", 0.35, 0, 2);
/** Defensive memory bound; normal production has far fewer live bots. */
export const MAX_SEND_ROUTE_PROFILES = Math.trunc(boundedEnv("LINE_H2_MAX_SEND_ROUTE_PROFILES", 2_048, 16, 16_384));

export interface SendRouteProfile {
	samples: number[];
	/** Cached when a result arrives, never recomputed while selecting a lane. */
	p50Ms?: number;
	p95Ms?: number;
	jitterMs?: number;
	lastAt: number;
	slowUntil: number;
}

export interface SendPrediction {
	p50Ms: number;
	p95Ms: number;
	jitterMs: number;
	queueMs: number;
	predictedMs: number;
}

function percentileFromSorted(sorted: readonly number[], fraction: number): number | undefined {
	if (sorted.length === 0) return undefined;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
	return sorted[index];
}

export function percentile(values: readonly number[], fraction: number): number | undefined {
	if (values.length === 0) return undefined;
	return percentileFromSorted(
		[...values].sort((left, right) => left - right),
		fraction,
	);
}

/**
 * Computes the small rolling distribution at write time. This is deliberately
 * separate from lane selection: sorting here happens once per completed SEND,
 * instead of once per candidate lane on every new SEND.
 */
export function summarizeSendSamples(samples: readonly number[]): Pick<SendPrediction, "p50Ms" | "p95Ms" | "jitterMs"> | undefined {
	if (samples.length === 0) return undefined;
	const sorted = [...samples].sort((left, right) => left - right);
	const p50Ms = percentileFromSorted(sorted, 0.5)!;
	const p95Ms = percentileFromSorted(sorted, 0.95)!;
	return { p50Ms, p95Ms, jitterMs: Math.max(0, p95Ms - p50Ms) };
}

export function recordSendRouteSample(
	profile: SendRouteProfile,
	sampleMs: number,
	now: number = Date.now(),
	slowThresholdMs: number = SEND_SLOW_THRESHOLD_MS,
): void {
	if (!Number.isFinite(sampleMs) || sampleMs < 0) return;
	profile.samples.push(sampleMs);
	if (profile.samples.length > SEND_SAMPLE_WINDOW) profile.samples.shift();
	const summary = summarizeSendSamples(profile.samples)!;
	profile.p50Ms = summary.p50Ms;
	profile.p95Ms = summary.p95Ms;
	profile.jitterMs = summary.jitterMs;
	profile.lastAt = now;
	profile.slowUntil = sampleMs > slowThresholdMs ? now + SEND_SLOW_COOLDOWN_MS : 0;
}

export function freshSendRouteProfile(
	profiles: ReadonlyMap<string, SendRouteProfile> | undefined,
	routeKey: string | undefined,
	now: number = Date.now(),
): SendRouteProfile | undefined {
	if (!profiles || !routeKey) return undefined;
	const profile = profiles.get(routeKey);
	return profile && now - profile.lastAt <= SEND_ROUTE_SAMPLE_MAX_AGE_MS ? profile : undefined;
}

export function getOrCreateSendRouteProfile(profiles: Map<string, SendRouteProfile>, routeKey: string): SendRouteProfile {
	let profile = profiles.get(routeKey);
	if (profile) {
		// Refresh insertion order so eviction removes the least-recently used key.
		profiles.delete(routeKey);
		profiles.set(routeKey, profile);
		return profile;
	}
	if (profiles.size >= MAX_SEND_ROUTE_PROFILES) {
		const oldest = profiles.keys().next().value as string | undefined;
		if (oldest !== undefined) profiles.delete(oldest);
	}
	profile = { samples: [], lastAt: 0, slowUntil: 0 };
	profiles.set(routeKey, profile);
	return profile;
}

/**
 * Predicts finish time from real SEND distribution and HTTP/2 capacity.
 * There is no guessed per-request penalty: queue cost appears only when the
 * peer's advertised concurrent-stream capacity is already occupied.
 */
export function predictSendCompletion(
	samples: readonly number[] | undefined,
	fallbackRttMs: number | undefined,
	inFlight: number,
	streamCapacity: number | undefined,
	jitterWeight: number = SEND_JITTER_WEIGHT,
): SendPrediction | undefined {
	const summary = samples ? summarizeSendSamples(samples) : undefined;
	return predictSendCompletionFromStats(summary?.p50Ms ?? fallbackRttMs, summary?.p95Ms, inFlight, streamCapacity, jitterWeight);
}

/** Allocation-free completion prediction used by the SEND lane hot path. */
export function predictSendCompletionFromStats(
	p50Ms: number | undefined,
	p95Ms: number | undefined,
	inFlight: number,
	streamCapacity: number | undefined,
	jitterWeight: number = SEND_JITTER_WEIGHT,
): SendPrediction | undefined {
	if (p50Ms === undefined || !Number.isFinite(p50Ms)) return undefined;
	const stableP95Ms = p95Ms === undefined || !Number.isFinite(p95Ms) ? p50Ms : p95Ms;
	const jitterMs = Math.max(0, stableP95Ms - p50Ms);
	const capacity = streamCapacity === undefined || !Number.isFinite(streamCapacity) ? undefined : Math.max(1, Math.trunc(streamCapacity));
	const queuedWaves = capacity === undefined ? 0 : Math.floor(Math.max(0, inFlight) / capacity);
	const queueMs = queuedWaves * p50Ms;
	return {
		p50Ms,
		p95Ms: stableP95Ms,
		jitterMs,
		queueMs,
		predictedMs: p50Ms + jitterMs * jitterWeight + queueMs,
	};
}

/** Uses the profile's write-time cache and never clones or sorts on selection. */
export function predictSendRouteCompletion(
	profile: SendRouteProfile,
	inFlight: number,
	streamCapacity: number | undefined,
	jitterWeight: number = SEND_JITTER_WEIGHT,
): SendPrediction | undefined {
	return predictSendCompletionFromStats(profile.p50Ms, profile.p95Ms, inFlight, streamCapacity, jitterWeight);
}
