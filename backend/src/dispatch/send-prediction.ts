import { SEND_SLOW_COOLDOWN_MS, SEND_SLOW_THRESHOLD_MS } from "./lane-speed-policy.ts";

function boundedEnv(name: string, fallback: number, min: number, max: number): number {
	const parsed = Number(process.env[name] ?? fallback);
	return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

/** Seven results react quickly while retaining enough history to expose a spike. */
export const SEND_SAMPLE_WINDOW = Math.trunc(boundedEnv("LINE_H2_SEND_SAMPLE_WINDOW", 7, 3, 31));
/** A bot-specific result older than this falls back to the lane's shared prior. */
export const SEND_ROUTE_SAMPLE_MAX_AGE_MS = boundedEnv("LINE_H2_SEND_ROUTE_SAMPLE_MAX_AGE_MS", 30_000, 1_000, 300_000);
/** Converts observed p95-p50 spread into a conservative completion estimate. */
export const SEND_JITTER_WEIGHT = boundedEnv("LINE_H2_SEND_JITTER_WEIGHT", 0.35, 0, 2);
/** Defensive memory bound; normal production has far fewer live bots. */
export const MAX_SEND_ROUTE_PROFILES = Math.trunc(boundedEnv("LINE_H2_MAX_SEND_ROUTE_PROFILES", 2_048, 16, 16_384));

export interface SendRouteProfile {
	samples: number[];
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

export function recordSendRouteSample(profile: SendRouteProfile, sampleMs: number, now: number = Date.now()): void {
	if (!Number.isFinite(sampleMs) || sampleMs < 0) return;
	profile.samples.push(sampleMs);
	if (profile.samples.length > SEND_SAMPLE_WINDOW) profile.samples.shift();
	profile.lastAt = now;
	profile.slowUntil = sampleMs > SEND_SLOW_THRESHOLD_MS ? now + SEND_SLOW_COOLDOWN_MS : 0;
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
	// Sorted once and reused for both percentiles: this runs per candidate lane
	// on every SEND selection, so a second clone+sort for p95 is wasted work.
	const sorted = samples && samples.length > 0 ? [...samples].sort((left, right) => left - right) : undefined;
	const p50Ms = (sorted ? percentileFromSorted(sorted, 0.5) : undefined) ?? fallbackRttMs;
	if (p50Ms === undefined || !Number.isFinite(p50Ms)) return undefined;
	const p95Ms = (sorted ? percentileFromSorted(sorted, 0.95) : undefined) ?? p50Ms;
	const jitterMs = Math.max(0, p95Ms - p50Ms);
	const capacity = streamCapacity === undefined || !Number.isFinite(streamCapacity) ? undefined : Math.max(1, Math.trunc(streamCapacity));
	const queuedWaves = capacity === undefined ? 0 : Math.floor(Math.max(0, inFlight) / capacity);
	const queueMs = queuedWaves * p50Ms;
	return {
		p50Ms,
		p95Ms,
		jitterMs,
		queueMs,
		predictedMs: p50Ms + jitterMs * jitterWeight + queueMs,
	};
}
