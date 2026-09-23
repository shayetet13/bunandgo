import { connect, constants, type ClientHttp2Session } from "node:http2";

interface Options {
	origin: string;
	lanes: number;
	requests: number;
	minDelayMs: number;
	maxDelayMs: number;
}

interface LaneResult {
	id: number;
	samples: number[];
	errors: string[];
}

function positiveInteger(name: string, fallback: number, maximum: number): number {
	const index = Bun.argv.indexOf(`--${name}`);
	const raw = index >= 0 ? Bun.argv[index + 1] : undefined;
	const value = raw === undefined ? fallback : Number(raw);
	if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`--${name} must be 1..${maximum}`);
	return value;
}

function options(): Options {
	const minDelayMs = positiveInteger("min-delay-ms", 120, 60_000);
	const maxDelayMs = positiveInteger("max-delay-ms", 280, 60_000);
	if (maxDelayMs < minDelayMs) throw new Error("--max-delay-ms must be >= --min-delay-ms");
	return {
		origin: "https://legy.line-apps.com",
		lanes: positiveInteger("lanes", 16, 64),
		requests: positiveInteger("requests", 500, 10_000),
		minDelayMs,
		maxDelayMs,
	};
}

function percentile(sorted: readonly number[], quantile: number): number | undefined {
	if (sorted.length === 0) return undefined;
	return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function rounded(value: number | undefined): number | undefined {
	return value === undefined ? undefined : Math.round(value * 100) / 100;
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(minimum: number, maximum: number): number {
	return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

async function openSession(origin: string): Promise<ClientHttp2Session> {
	const session = connect(origin);
	const timeout = setTimeout(() => session.destroy(new Error("connect timeout")), 10_000);
	try {
		await new Promise<void>((resolve, reject) => {
			session.once("connect", resolve);
			session.once("error", reject);
		});
		if ("setNoDelay" in session.socket && typeof session.socket.setNoDelay === "function") session.socket.setNoDelay(true);
		return session;
	} finally {
		clearTimeout(timeout);
	}
}

async function headSq1(session: ClientHttp2Session, origin: string): Promise<number> {
	const startedAt = performance.now();
	return new Promise<number>((resolve, reject) => {
		let status = 0;
		let settled = false;
		const stream = session.request({
			[constants.HTTP2_HEADER_METHOD]: "HEAD",
			[constants.HTTP2_HEADER_SCHEME]: "https",
			[constants.HTTP2_HEADER_AUTHORITY]: new URL(origin).host,
			[constants.HTTP2_HEADER_PATH]: "/SQ1",
			"accept-encoding": "identity",
		});
		const timeout = setTimeout(() => {
			stream.close(constants.NGHTTP2_CANCEL);
			finish(new Error("request timeout"));
		}, 10_000);

		function finish(error?: Error): void {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (error) reject(error);
			else if (status === 0) reject(new Error("response had no HTTP status"));
			else resolve(performance.now() - startedAt);
		}

		stream.once("response", (headers) => {
			status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0);
		});
		stream.once("error", (error) => finish(error));
		stream.once("close", () => finish());
		stream.end();
	});
}

async function main(): Promise<void> {
	const config = options();
	const sessions = await Promise.all(Array.from({ length: config.lanes }, () => openSession(config.origin)));
	const results: LaneResult[] = sessions.map((_session, id) => ({ id, samples: [], errors: [] }));

	try {
		// One unmeasured request per connection removes first-stream setup. The
		// requested sample count below therefore represents already-warm lanes.
		await Promise.all(sessions.map((session) => headSq1(session, config.origin)));

		for (let index = 0; index < config.requests; index++) {
			const laneId = index % sessions.length;
			try {
				results[laneId]!.samples.push(await headSq1(sessions[laneId]!, config.origin));
			} catch (error) {
				results[laneId]!.errors.push(error instanceof Error ? error.message : String(error));
			}
			if (index + 1 < config.requests) await wait(jitter(config.minDelayMs, config.maxDelayMs));
		}
	} finally {
		for (const session of sessions) session.close();
	}

	const lanes = results.map((lane) => {
		const sorted = [...lane.samples].sort((left, right) => left - right);
		const sum = sorted.reduce((total, value) => total + value, 0);
		return {
			laneId: lane.id,
			samples: sorted.length,
			errors: lane.errors.length,
			minMs: rounded(sorted[0]),
			avgMs: rounded(sorted.length ? sum / sorted.length : undefined),
			p50Ms: rounded(percentile(sorted, 0.5)),
			p95Ms: rounded(percentile(sorted, 0.95)),
			maxMs: rounded(sorted.at(-1)),
			under20: sorted.filter((value) => value < 20).length,
			from20To23: sorted.filter((value) => value >= 20 && value < 23).length,
			atLeast23: sorted.filter((value) => value >= 23).length,
		};
	});
	const all = results.flatMap((lane) => lane.samples).sort((left, right) => left - right);
	const total = all.reduce((sum, value) => sum + value, 0);
	console.log(
		JSON.stringify(
			{
				mode: "unauthenticated HEAD /SQ1; no bot token, login, poll, or message",
				origin: config.origin,
				configuredLanes: config.lanes,
				requestedSamples: config.requests,
				delayMs: { min: config.minDelayMs, max: config.maxDelayMs },
				summary: {
					samples: all.length,
					errors: lanes.reduce((sum, lane) => sum + lane.errors, 0),
					lanesUsed: lanes.filter((lane) => lane.samples > 0).length,
					minMs: rounded(all[0]),
					avgMs: rounded(all.length ? total / all.length : undefined),
					p50Ms: rounded(percentile(all, 0.5)),
					p95Ms: rounded(percentile(all, 0.95)),
					maxMs: rounded(all.at(-1)),
					under20: all.filter((value) => value < 20).length,
					from20To23: all.filter((value) => value >= 20 && value < 23).length,
					atLeast23: all.filter((value) => value >= 23).length,
				},
				lanes,
			},
			null,
			2,
		),
	);
}

await main();
