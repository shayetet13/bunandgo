/**
 * Measures the pure transport floor between this machine and LINE's LEGY
 * edge, so a slow reply can be attributed to the network or to LINE's own
 * per-endpoint processing instead of guessed at.
 *
 * The dashboard's LINE column is `upstreamMs` — the whole `fetch()` around
 * one send. That number contains three things:
 *
 *   network RTT + TLS-warm edge ack   <- what this script measures
 *   + LINE application processing     <- differs a lot per endpoint
 *   + response body transfer          <- bigger for `/SQ1` than `/CA5`
 *
 * Run it on the server that actually hosts the bot:
 *
 *   bun run backend/scripts/probe-line-rtt.ts
 *
 * Reading the result: whatever this reports is the floor no code change can
 * go under. Everything above it, on a warm connection, belongs to LINE.
 */

import { connect as connectHttp2, type ClientHttp2Session } from "node:http2";
import { lookup } from "node:dns/promises";

const HOSTS = ["legy.line-apps.com", "gf.line.naver.jp"] as const;
const SAMPLES = 30;
/** Matches the production warm interval so the connection state is comparable. */
const WARMUP = 3;

function percentile(sortedAsc: number[], p: number): number {
	if (sortedAsc.length === 0) return 0;
	return sortedAsc[Math.min(sortedAsc.length - 1, Math.ceil(sortedAsc.length * p) - 1)]!;
}

function summarize(samples: number[]): string {
	const sorted = [...samples].sort((a, b) => a - b);
	const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
	return [
		`min ${sorted[0]!.toFixed(2)}ms`,
		`p50 ${percentile(sorted, 0.5).toFixed(2)}ms`,
		`p95 ${percentile(sorted, 0.95).toFixed(2)}ms`,
		`max ${sorted.at(-1)!.toFixed(2)}ms`,
		`mean ${mean.toFixed(2)}ms`,
	].join("  ");
}

function openSession(host: string): Promise<ClientHttp2Session> {
	const session = connectHttp2(`https://${host}`);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("connect timeout")), 10_000);
		session.once("connect", () => {
			clearTimeout(timer);
			session.off("error", reject);
			resolve(session);
		});
		session.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

/** One HEAD on an already-established h2 session: RTT plus LINE's edge ack. */
function timeH2Head(session: ClientHttp2Session, host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const started = performance.now();
		const request = session.request({
			":method": "HEAD",
			":path": "/",
			":scheme": "https",
			":authority": host,
		});
		request.once("response", () => {
			const took = performance.now() - started;
			request.close();
			resolve(took);
		});
		request.once("error", reject);
		request.end();
	});
}

/** Same probe through Bun's fetch — the transport production sends on. */
async function timeFetchHead(host: string): Promise<number> {
	const started = performance.now();
	const response = await fetch(`https://${host}/`, {
		method: "HEAD",
		signal: AbortSignal.timeout(10_000),
	});
	await response.arrayBuffer();
	return performance.now() - started;
}

async function probe(host: string): Promise<void> {
	const address = await lookup(host).catch(() => undefined);
	console.log(`\n=== ${host}${address ? ` (${address.address})` : ""} ===`);

	const coldStarted = performance.now();
	const session = await openSession(host);
	console.log(`  cold connect (TCP+TLS+h2): ${(performance.now() - coldStarted).toFixed(2)}ms`);

	try {
		const h2: number[] = [];
		for (let i = 0; i < SAMPLES + WARMUP; i++) {
			const took = await timeH2Head(session, host);
			if (i >= WARMUP) h2.push(took);
		}
		console.log(`  warm h2 HEAD     : ${summarize(h2)}`);
	} finally {
		session.close();
	}

	const viaFetch: number[] = [];
	for (let i = 0; i < SAMPLES + WARMUP; i++) {
		const took = await timeFetchHead(host);
		if (i >= WARMUP) viaFetch.push(took);
	}
	console.log(`  warm fetch HEAD  : ${summarize(viaFetch)}`);
}

for (const host of HOSTS) {
	try {
		await probe(host);
	} catch (error) {
		console.error(`  failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

console.log(
	"\nThe warm numbers above are the floor. A reply's LINE column minus this\n" +
		"floor is time spent inside LINE's handler for that endpoint — `/SQ1`\n" +
		"(OpenChat) does member fan-out and moderation that `/CA5` (talk) does not.",
);
