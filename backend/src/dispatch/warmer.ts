import type { DispatchConfig } from "./client.ts";
import { ensureLanes } from "./h2-lanes.ts";

/**
 * Hosts that carry the outbound legs of a reply. Both must stay warm:
 * they are different origins with very different characteristics, and a
 * cold handshake on either one dwarfs the request it precedes.
 *
 * Measured on a Thai connection:
 *   legy.line-apps.com  cold 146ms / warm  29ms  (square `/SQ1`)
 *   gf.line.naver.jp    cold 335ms / warm  99ms  (LEGY-wrapped talk paths)
 */
export const WARM_HOSTS = ["legy.line-apps.com", "gf.line.naver.jp"] as const;

/** The origin that carries every latency-sensitive send. */
const HOT_SEND_HOST = WARM_HOSTS[0];

/**
 * The only host worth owning dedicated lanes for: every hot send (`/CA5`,
 * `/ECA5`, `/SQ1`) resolves to the client's default endpoint. `gf` carries
 * LEGY-wrapped calls that are not on the reply hot path, so it stays on
 * Bun's pool rather than costing extra connections for nothing.
 */
const LANE_ORIGIN = `https://${WARM_HOSTS[0]}`;

/**
 * Comfortably inside the Go relay's 300s idle timeout while also staying
 * close to LINE's own 30s push ping cadence, so the traffic pattern looks
 * like a client that is simply connected rather than one probing.
 */
const WARM_INTERVAL_MS = 25_000;

export interface WarmResult {
	host: string;
	tookMs: number;
	status?: number;
	error?: string;
}

async function warmDirect(hosts: readonly string[]): Promise<WarmResult[]> {
	return Promise.all(hosts.map(async (host): Promise<WarmResult> => {
		const started = performance.now();
		try {
			const response = await globalThis.fetch(`https://${host}/`, {
				method: "HEAD",
				signal: AbortSignal.timeout(10_000),
			});
			return { host: `bun:${host}`, tookMs: performance.now() - started, status: response.status };
		} catch (error) {
			return {
				host: `bun:${host}`,
				tookMs: performance.now() - started,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}));
}

async function warmGo(config: DispatchConfig, hosts: readonly string[]): Promise<WarmResult[]> {
	const url = new URL(config.url);
	url.pathname = "/warm";

	const res = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-dispatch-token": config.token,
		},
		body: JSON.stringify({ hosts }),
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) {
		throw new Error(`warm relay error: HTTP ${res.status}`);
	}
	const payload = (await res.json()) as { results: WarmResult[] };
	return payload.results.map((result) => ({ ...result, host: `go:${result.host}` }));
}

/**
 * Brings the owned HTTP/2 lanes up alongside the pooled connections.
 *
 * Failures are logged, never thrown: `laneFetch` falls back to Bun's pool
 * when no lane is healthy, so a lane problem must not be what stops a bot
 * from coming online.
 */
async function warmLanes(): Promise<void> {
	try {
		await ensureLanes(LANE_ORIGIN);
	} catch (error) {
		console.error(
			`[warmer] lanes for ${LANE_ORIGIN} unavailable, falling back to the pool: ` +
				`${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** Keeps every connection pool used by the selected transport warm. */
export async function warmOnce(
	config: DispatchConfig,
	hosts: readonly string[] = WARM_HOSTS,
): Promise<WarmResult[]> {
	const transport = process.env.LINE_TRANSPORT ?? "hybrid";
	if (transport === "go") return warmGo(config, hosts);
	if (transport === "direct") {
		const [directResults] = await Promise.all([warmDirect(hosts), warmLanes()]);
		return directResults;
	}

	const [goResults, directResults] = await Promise.all([
		warmGo(config, hosts),
		warmDirect(hosts),
		warmLanes(),
	]);
	return [...goResults, ...directResults];
}

let timer: ReturnType<typeof setInterval> | undefined;
let warmInFlight: Promise<WarmResult[]> | undefined;
let lastWarmSuccessAt = 0;

/** True when at least one transport can reach the latency-sensitive origin. */
export function hasWarmHotSendRoute(results: readonly WarmResult[]): boolean {
	return results.some((result) => result.host.endsWith(HOT_SEND_HOST) && !result.error);
}

/** Ensures startup/reconnect never advertises a bot before the pool is warm. */
export function ensureWarm(config: DispatchConfig): Promise<WarmResult[]> {
	if (Date.now() - lastWarmSuccessAt < WARM_INTERVAL_MS) return Promise.resolve([]);
	if (warmInFlight) return warmInFlight;
	warmInFlight = warmOnce(config).then((results) => {
		// `gf` is used by LEGY-wrapped control/login calls, but it is not on the
		// automatic-reply path. Some networks accept TCP/TLS to that origin yet
		// never answer `HEAD /`; treating that optional probe as a failure kept
		// the whole warmer red and could stop an otherwise-ready bot from being
		// published online. The readiness gate only requires at least one warm
		// route to the origin that actually carries `/SQ1`, `/CA5`, and `/ECA5`.
		const hotSendReady = hasWarmHotSendRoute(results);
		if (!hotSendReady) {
			const failures = results.filter((result) => result.host.endsWith(HOT_SEND_HOST));
			throw new Error(
				failures.length
					? failures.map((result) =>
						`${result.host}: ${result.error ?? "no successful warm route"}`
					).join("; ")
					: `${HOT_SEND_HOST}: no warm result`,
			);
		}
		lastWarmSuccessAt = Date.now();
		return results;
	}).finally(() => {
		warmInFlight = undefined;
	});
	return warmInFlight;
}

/**
 * Keeps the outbound connections warm for as long as the process lives.
 *
 * Runs unconditionally rather than only while a bot is online: a bot that
 * has just been started would otherwise pay the full handshake on its
 * first reply, which is exactly the reply that matters most.
 */
export function startWarmer(config: DispatchConfig): void {
	if (timer) return;

	const tick = async (): Promise<void> => {
		try {
			const results = await ensureWarm(config);
			for (const r of results) {
				if (r.error) console.error(`[warmer] ${r.host} failed after ${r.tookMs}ms: ${r.error}`);
			}
		} catch (err) {
			// A failed warm-up is not fatal — the next tick retries — but it
			// must be visible, otherwise every send silently eats a cold
			// handshake with no signal pointing at why.
			console.error(`[warmer] tick failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	void tick();
	timer = setInterval(() => void tick(), WARM_INTERVAL_MS);
	// Never let the warmer be the reason the process stays alive.
	timer.unref?.();
}
