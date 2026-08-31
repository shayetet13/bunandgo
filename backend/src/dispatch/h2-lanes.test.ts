import { afterEach, describe, expect, test } from "bun:test";
import { createServer, constants, type Http2Server, type ServerHttp2Stream, type IncomingHttpHeaders } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
	buildHeaders,
	decodeBody,
	ensureLanes,
	fastestSendCandidates,
	H2_LANE_ROLE_HEADER,
	H2_LANE_ROUTE_KEY_HEADER,
	laneAddressStride,
	laneCandidates,
	laneFetch,
	laneStats,
	pollingCandidatesForCalibration,
	primeLanes,
	selectAgedLaneForRecycle,
	selectDegradedLaneForRepair,
	selectFastestSendLaneCandidate,
	selectLaneRouteAddress,
	selectPollingLaneCandidate,
	shouldPreferFastestSendLane,
	shouldPreferLane,
	stopLanes,
} from "./h2-lanes.ts";
import { readResponseBytes } from "./raw-response.ts";

type StreamHandler = (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => void;

interface TestServer {
	origin: string;
	server: Http2Server;
}

/**
 * Plain h2c rather than TLS: the lane logic under test is the HTTP/2
 * request/response and failure handling, none of which changes with a
 * transport certificate, and keying the pool on origin means the test can
 * point at http://127.0.0.1 without a production-only escape hatch.
 */
function startServer(handler: StreamHandler): Promise<TestServer> {
	const server = createServer();
	server.on("stream", handler);
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			resolve({ origin: `http://127.0.0.1:${port}`, server });
		});
	});
}

function stopServer(server: Http2Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

let running: Http2Server | undefined;

afterEach(async () => {
	stopLanes();
	if (running) await stopServer(running);
	running = undefined;
});

describe("owned HTTP/2 lanes", () => {
	test("carries a send and returns the decoded body", async () => {
		const { origin, server } = await startServer((stream, headers) => {
			stream.respond({ ":status": 200, "x-echo-method": String(headers[":method"]) });
			stream.end(Buffer.from([0x82, 0x21, 0x00]));
		});
		running = server;

		await ensureLanes(origin);
		const response = await laneFetch(`${origin}/SQ1`, {
			method: "POST",
			body: new Uint8Array([1, 2, 3]) as BodyInit,
		});

		expect(response).toBeDefined();
		expect(response!.status).toBe(200);
		expect(response!.headers.get("x-echo-method")).toBe("POST");
		expect(await readResponseBytes(response!)).toEqual(new Uint8Array([0x82, 0x21, 0x00]));
	});

	test("cools a lane after a raw SEND result over the slow floor", async () => {
		const { origin, server } = await startServer((stream) => {
			setTimeout(() => {
				stream.respond({ ":status": 200 });
				stream.end();
			}, 35);
		});
		running = server;

		await ensureLanes(origin);
		await laneFetch(`${origin}/CA5`, { method: "POST", body: new Uint8Array([1]) as BodyInit });

		// 35ms is past the 28ms absolute floor even with no faster lane to
		// compare against, so it still cools. A 24ms result would not.
		const used = laneStats().find((lane) => lane.lastSendOkAt > 0);
		expect(used?.sendRttMs).toBeGreaterThan(28);
		expect(used?.sendSlowUntil).toBeGreaterThan(Date.now());
	});

	test("flags a lane degraded after several consecutive slow results", async () => {
		const { origin, server } = await startServer((stream) => {
			setTimeout(() => {
				stream.respond({ ":status": 200 });
				stream.end();
			}, 35);
		});
		running = server;

		await ensureLanes(origin);
		// Every real result is uniformly slow, so no lane ever gets a fast
		// sample to reset its streak. Real load-balancing does not guarantee
		// an even split across the pool, so this only asserts the wiring
		// actually flips the flag on real traffic somewhere, not on which
		// lane — that distribution is the selector tests' job, not this one's.
		for (let i = 0; i < 24; i++) {
			await laneFetch(`${origin}/CA5`, { method: "POST", body: new Uint8Array([1]) as BodyInit });
		}

		expect(laneStats().some((lane) => lane.degraded)).toBe(true);
	});

	test("delivers the request body unchanged", async () => {
		let received: Buffer | undefined;
		const { origin, server } = await startServer((stream) => {
			const chunks: Buffer[] = [];
			stream.on("data", (chunk: Buffer) => chunks.push(chunk));
			stream.on("end", () => {
				received = Buffer.concat(chunks);
				stream.respond({ ":status": 200 });
				stream.end();
			});
		});
		running = server;

		await ensureLanes(origin);
		await laneFetch(`${origin}/CA5`, {
			method: "POST",
			body: new Uint8Array([9, 8, 7, 6]) as BodyInit,
		});

		expect(received).toEqual(Buffer.from([9, 8, 7, 6]));
	});

	test("sends each request exactly once even if lane selection changes", async () => {
		let requests = 0;
		const { origin, server } = await startServer((stream) => {
			requests++;
			stream.respond({ ":status": 200 });
			stream.end(Buffer.from([1]));
		});
		running = server;

		await ensureLanes(origin);
		for (let i = 0; i < 5; i++) {
			await laneFetch(`${origin}/CA5`, { method: "POST", body: new Uint8Array([1]) as BodyInit });
		}

		expect(requests).toBe(5);
	});

	test("keeps a warm HEAD out of real send and poll measurements", async () => {
		const { origin, server } = await startServer((stream) => {
			stream.respond({ ":status": 204 });
			stream.end();
		});
		running = server;

		await ensureLanes(origin);
		await laneFetch(`${origin}/`, { method: "HEAD", headers: { [H2_LANE_ROLE_HEADER]: "warm" } });

		const used = laneStats().filter((lane) => lane.lastOkAt > 0);
		expect(used).toHaveLength(1);
		expect(used[0]!.sendRttMs).toBeUndefined();
		expect(used[0]!.pollRttMs).toBeUndefined();
		expect(used[0]!.applicationRttMs).toBeUndefined();
		expect(used[0]!.routingPreferred).toBe(false);
	});

	test("primes every lane once without fabricating an application sample", async () => {
		let requests = 0;
		const sessions = new Set<object>();
		const { origin, server } = await startServer((stream) => {
			requests++;
			sessions.add(stream.session!);
			stream.respond({ ":status": 204 });
			stream.end();
		});
		running = server;

		await primeLanes(origin);
		const lanes = laneStats();
		expect(requests).toBe(lanes.length);
		expect(sessions.size).toBe(lanes.length);
		expect(lanes.every((lane) => lane.lastOkAt > 0)).toBe(true);
		expect(lanes.every((lane) => lane.applicationRttMs === undefined)).toBe(true);

		await primeLanes(origin);
		expect(requests).toBe(lanes.length);
	});

	test("re-primes a replacement connection after GOAWAY", async () => {
		let requests = 0;
		const sessions: object[] = [];
		const { origin, server } = await startServer((stream) => {
			requests++;
			if (!sessions.includes(stream.session!)) sessions.push(stream.session!);
			stream.respond({ ":status": 204 });
			stream.end();
		});
		running = server;

		await primeLanes(origin);
		const initialRequests = requests;
		const initialSessions = sessions.length;
		(sessions[0] as { goaway: (code: number, lastStreamId: number) => void }).goaway(constants.NGHTTP2_NO_ERROR, 0);

		for (let attempt = 0; attempt < 20 && requests === initialRequests; attempt++) await Bun.sleep(50);
		expect(sessions.length).toBeGreaterThan(initialSessions);
		expect(requests).toBe(initialRequests + 1);
		expect(laneStats().filter((lane) => lane.lastOkAt > 0)).toHaveLength(laneStats().length);
	});

	test("holds a standby lane alongside the one in use", async () => {
		const { origin, server } = await startServer((stream) => {
			stream.respond({ ":status": 200 });
			stream.end(Buffer.from([1]));
		});
		running = server;

		await ensureLanes(origin);
		await laneFetch(`${origin}/CA5`, { method: "POST", body: new Uint8Array([1]) as BodyInit });

		const ready = laneStats().filter((lane) => lane.state === "ready");
		expect(ready.length).toBeGreaterThan(1);
	});

	test("calibrates an unknown poll lane while keeping send on the proven measured lane", async () => {
		const sessions = new Map<object, number>();
		let nextSession = 0;
		let primeSession = -1;
		let holdSession = -1;
		let sendSession = -1;
		let heldStream: ServerHttp2Stream | undefined;
		let releaseHeld!: () => void;
		const heldSeen = new Promise<void>((resolve) => {
			releaseHeld = resolve;
		});
		const { origin, server } = await startServer((stream, headers) => {
			const session = stream.session!;
			let id = sessions.get(session);
			if (id === undefined) {
				id = nextSession++;
				sessions.set(session, id);
			}
			const path = String(headers[":path"]);
			if (path.includes("prime")) primeSession = id;
			if (path.includes("hold")) {
				holdSession = id;
				heldStream = stream;
				releaseHeld();
				return;
			}
			if (path.includes("send")) sendSession = id;
			stream.respond({ ":status": 200 });
			stream.end(Buffer.from([1]));
		});
		running = server;

		await ensureLanes(origin);
		await laneFetch(`${origin}/SQ1?op=prime`, {
			method: "POST",
			headers: { [H2_LANE_ROLE_HEADER]: "poll" },
			body: new Uint8Array([1]) as BodyInit,
		});
		const pendingPoll = laneFetch(`${origin}/SQ1?op=hold`, {
			method: "POST",
			headers: { [H2_LANE_ROLE_HEADER]: "poll" },
			body: new Uint8Array([2]) as BodyInit,
		});
		await heldSeen;
		await laneFetch(`${origin}/SQ1?op=send`, {
			method: "POST",
			headers: { [H2_LANE_ROLE_HEADER]: "send" },
			body: new Uint8Array([3]) as BodyInit,
		});

		heldStream!.respond({ ":status": 200 });
		heldStream!.end(Buffer.from([1]));
		await pendingPoll;

		expect(holdSession).not.toBe(primeSession);
		expect(sendSession).not.toBe(holdSession);
	});

	test("calibrates every poll lane once, then continually re-ranks measured results", async () => {
		const sessions = new Set<object>();
		const sequence: object[] = [];
		let requests = 0;
		const { origin, server } = await startServer((stream) => {
			requests++;
			sessions.add(stream.session!);
			sequence.push(stream.session!);
			stream.respond({ ":status": 200 });
			stream.end(Buffer.from([1]));
		});
		running = server;

		await ensureLanes(origin);
		for (let i = 0; i < 12; i++) {
			await laneFetch(`${origin}/SQ1?poll=${i}`, {
				method: "POST",
				headers: { [H2_LANE_ROLE_HEADER]: "poll" },
				body: new Uint8Array([i]) as BodyInit,
			});
		}

		expect(requests).toBe(12);
		expect(sessions.size).toBe(6);
		expect(new Set(sequence.slice(0, 6)).size).toBe(6);
	});

	test("falls back to the caller's fetch when no lane exists for the origin", async () => {
		const response = await laneFetch("https://legy.line-apps.com/SQ1", { method: "POST" });
		expect(response).toBeUndefined();
	});

	test("fails a send that got no response instead of resending it", async () => {
		let seen = 0;
		const { origin, server } = await startServer((stream) => {
			seen++;
			// The connection dies with the request in flight. Whether LINE
			// processed it is unknowable, so the send must surface as an
			// error rather than be quietly repeated or reported as an empty
			// success.
			stream.session?.destroy();
		});
		running = server;

		await ensureLanes(origin);
		await expect(laneFetch(`${origin}/SQ1`, { method: "POST", body: new Uint8Array([1]) as BodyInit })).rejects.toThrow();
		expect(seen).toBe(1);
	});

	test("stops using a lane LINE has said goodbye to", async () => {
		const { origin, server } = await startServer((stream) => {
			stream.respond({ ":status": 200 });
			stream.end(Buffer.from([1]));
		});
		// GOAWAY the first session the client opens, which is the one the
		// first send rides; the standby lane must take over from there.
		let sessions = 0;
		server.on("session", (session) => {
			sessions++;
			if (sessions === 1) setTimeout(() => session.goaway(constants.NGHTTP2_NO_ERROR, 0), 60);
		});
		running = server;

		await ensureLanes(origin);
		const before = await laneFetch(`${origin}/CA5`, { method: "POST", body: new Uint8Array([1]) as BodyInit });
		expect(before).toBeDefined();
		const goawayLane = laneStats().find((lane) => lane.lastOkAt > 0)!;

		await Bun.sleep(200);
		const after = await laneFetch(`${origin}/CA5`, { method: "POST", body: new Uint8Array([1]) as BodyInit });
		expect(after).toBeDefined();

		const stillCarrying = laneStats().filter((lane) => lane.lastOkAt > 0);
		expect(stillCarrying.some((lane) => lane.id !== goawayLane.id)).toBe(true);
	});

	test("aborts in flight when the caller's timeout fires", async () => {
		const { origin, server } = await startServer(() => {
			// Never responds — the caller's AbortSignal is the only way out.
		});
		running = server;

		await ensureLanes(origin);
		await expect(
			laneFetch(`${origin}/SQ1`, {
				method: "POST",
				body: new Uint8Array([1]) as BodyInit,
				signal: AbortSignal.timeout(120),
			}),
		).rejects.toThrow();
	});

	test("reports a lane that could not be opened rather than pretending it is up", async () => {
		await expect(ensureLanes("http://127.0.0.1:1")).rejects.toThrow();
		expect(laneStats().every((lane) => lane.state !== "ready")).toBe(true);
	});
});

describe("RTT-aware lane ranking", () => {
	test("spreads consecutive lane ids across the whole fast-IP pool and rotates on reconnect", () => {
		// The pin file lists all IPv4 then all IPv6; a plain +1 offset kept the
		// low-numbered reserved SEND lanes (0..3) permanently on the IPv4 half.
		const addresses = [
			{ address: "147.92.146.129", family: 4 as const },
			{ address: "147.92.146.138", family: 4 as const },
			{ address: "2400:dcc0:a3a1:1000::1", family: 6 as const },
			{ address: "2400:dcc0:a3a1:1000::2", family: 6 as const },
		];

		// Every lane id visits a distinct address over one span of the pool.
		expect(new Set(Array.from({ length: 4 }, (_, laneId) => selectLaneRouteAddress(addresses, laneId).address))).toEqual(
			new Set(addresses.map(({ address }) => address)),
		);
		// Consecutive SEND lanes 0..3 straddle both families rather than clustering.
		const sendLaneFamilies = [0, 1, 2, 3].map((laneId) => selectLaneRouteAddress(addresses, laneId).family);
		expect(sendLaneFamilies).toContain(4);
		expect(sendLaneFamilies).toContain(6);
		// Stride 3 for a 4-address pool: (laneId * 3 + rotation) % 4.
		expect(selectLaneRouteAddress(addresses, 0, 0)).toEqual(addresses[0]);
		expect(selectLaneRouteAddress(addresses, 1, 0)).toEqual(addresses[3]);
		expect(selectLaneRouteAddress(addresses, 0, 1)).toEqual(addresses[1]);
		expect(laneAddressStride(8)).toBe(3);
		expect(laneAddressStride(2)).toBe(1);
	});

	test("prefers a materially faster route even after accounting for one in-flight stream", () => {
		expect(shouldPreferLane({ rttMs: 1.0, lastOkAt: 10, inFlight: 1 }, { rttMs: 8.0, lastOkAt: 20, inFlight: 0 }, "send")).toBeTrue();
	});

	test("chooses the faster SEND estimate even when that lane already has a stream", () => {
		expect(shouldPreferLane({ rttMs: 2.3, lastOkAt: 10, inFlight: 1 }, { rttMs: 5.6, lastOkAt: 20, inFlight: 0 }, "send")).toBeTrue();
	});

	test("ranks send lanes by real application RTT before network ping", () => {
		expect(
			shouldPreferLane(
				{ rttMs: 5, sendRttMs: 12, lastOkAt: 10, inFlight: 0 },
				{ rttMs: 2, sendRttMs: 25, lastOkAt: 20, inFlight: 0 },
				"send",
			),
		).toBeTrue();
	});

	test("uses the lower latest real application result regardless of its absolute value", () => {
		expect(
			shouldPreferFastestSendLane(
				{ sendRttMs: 80, lastSendOkAt: 10, lastOkAt: 10, inFlight: 0 },
				{ sendRttMs: 90, lastSendOkAt: 20, lastOkAt: 20, inFlight: 0 },
			),
		).toBe(true);
	});

	test("switches SEND at the exact default 0.10ms boundary", () => {
		const current = { sendRttMs: 22, lastSendOkAt: 10, lastOkAt: 10, inFlight: 0 };
		expect(shouldPreferFastestSendLane({ sendRttMs: 21.9, lastSendOkAt: 9, lastOkAt: 9, inFlight: 0 }, current)).toBe(true);
		expect(shouldPreferFastestSendLane({ sendRttMs: 21.91, lastSendOkAt: 9, lastOkAt: 9, inFlight: 0 }, current)).toBe(false);
	});

	test("switches POLL at the exact default 0.10ms boundary", () => {
		const current = { pollRttMs: 22, lastPollOkAt: 10, lastOkAt: 10, inFlight: 0 };
		expect(shouldPreferLane({ pollRttMs: 21.9, lastPollOkAt: 9, lastOkAt: 9, inFlight: 0 }, current, "poll")).toBe(true);
		expect(shouldPreferLane({ pollRttMs: 21.91, lastPollOkAt: 9, lastOkAt: 9, inFlight: 0 }, current, "poll")).toBe(false);
	});

	test("calibrates every unmeasured poll lane before settling on a winner", () => {
		const lanes = [
			{ id: 4, pollRttMs: 21, lastPollOkAt: 300, lastOkAt: 300, inFlight: 0 },
			{ id: 5, pollRttMs: undefined, rttMs: 7, lastPollOkAt: 0, lastOkAt: 0, inFlight: 0 },
			{ id: 6, pollRttMs: 14, lastPollOkAt: 200, lastOkAt: 200, inFlight: 0 },
		];
		expect(selectPollingLaneCandidate(lanes)?.id).toBe(5);
	});

	test("calibrates the unknown lane with the lowest PING first", () => {
		const lanes = [
			{ id: 4, pollRttMs: undefined, rttMs: 8, lastPollOkAt: 0, lastOkAt: 100, inFlight: 0 },
			{ id: 5, pollRttMs: undefined, rttMs: 3, lastPollOkAt: 0, lastOkAt: 200, inFlight: 1 },
			{ id: 6, pollRttMs: undefined, rttMs: 5, lastPollOkAt: 0, lastOkAt: 300, inFlight: 0 },
		];
		expect(selectPollingLaneCandidate(lanes)?.id).toBe(5);
	});

	test("chooses the lowest measured RTT with no pass/fail threshold", () => {
		const lanes = [
			{ id: 4, pollRttMs: 80, lastPollOkAt: 100, lastOkAt: 100, inFlight: 3 },
			{ id: 5, pollRttMs: 95, lastPollOkAt: 200, lastOkAt: 200, inFlight: 0 },
		];
		expect(selectPollingLaneCandidate(lanes)?.id).toBe(4);
	});

	test("keeps freshness/load tie-breakers when RTTs differ only by noise", () => {
		expect(shouldPreferLane({ rttMs: 2.75, lastOkAt: 10, inFlight: 0 }, { rttMs: 2.8, lastOkAt: 20, inFlight: 0 }, "send")).toBeFalse();
		expect(shouldPreferLane({ rttMs: 2.75, lastOkAt: 10, inFlight: 0 }, { rttMs: 2.8, lastOkAt: 20, inFlight: 1 }, "poll")).toBeTrue();
	});
});

describe("send-reserved lanes", () => {
	const lanes = [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }];

	test("keeps every lane shared when no reservation is configured", () => {
		expect(laneCandidates(lanes, "send", 0)).toEqual(lanes);
		expect(laneCandidates(lanes, "poll", 0)).toEqual(lanes);
	});

	test("splits sends onto the reserved lanes and polls onto the rest", () => {
		expect(laneCandidates(lanes, "send", 1)).toEqual([{ id: 0 }]);
		expect(laneCandidates(lanes, "poll", 1)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
	});

	test("honours a reservation wider than one lane", () => {
		expect(laneCandidates(lanes, "send", 2)).toEqual([{ id: 0 }, { id: 1 }]);
		expect(laneCandidates(lanes, "poll", 2)).toEqual([{ id: 2 }, { id: 3 }]);
	});

	// The reservation is a routing preference. Losing every lane on one side
	// of it must widen the choice, never strand a request that some live
	// connection could still carry.
	test("falls back to polling lanes when every reserved lane is down", () => {
		const survivors = [{ id: 2 }, { id: 3 }];
		expect(laneCandidates(survivors, "send", 2)).toEqual(survivors);
	});

	test("falls back to reserved lanes when every polling lane is down", () => {
		const survivors = [{ id: 0 }];
		expect(laneCandidates(survivors, "poll", 1)).toEqual(survivors);
	});

	test("leaves traffic with no role hint free to use any lane", () => {
		expect(laneCandidates(lanes, undefined, 2)).toEqual(lanes);
	});

	test("calibrates reserved lanes once before restoring the poll partition", () => {
		const partlyMeasured = [
			{ id: 0, pollRttMs: undefined },
			{ id: 1, pollRttMs: 20 },
			{ id: 2, pollRttMs: undefined },
			{ id: 3, pollRttMs: 18 },
		];
		expect(pollingCandidatesForCalibration(partlyMeasured, 2).map((lane) => lane.id)).toEqual([0, 2]);
		const measured = partlyMeasured.map((lane, index) => ({ ...lane, pollRttMs: lane.pollRttMs ?? 30 + index }));
		expect(pollingCandidatesForCalibration(measured, 2).map((lane) => lane.id)).toEqual([2, 3]);
	});

	test("keeps every usable lane in contention without treating POLL as SEND", () => {
		const measured = [
			{ id: 0, sendRttMs: 80, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
			{ id: 1, sendRttMs: 95, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
			{ id: 2, pollRttMs: 70, lastPollOkAt: 1, lastOkAt: 1, inFlight: 0 },
			{ id: 3, pollRttMs: 60, lastPollOkAt: 1, lastOkAt: 1, inFlight: 1 },
		];
		expect(fastestSendCandidates(measured).map((lane) => lane.id)).toEqual([0, 1, 2, 3]);
	});

	test("keeps a faster multiplexed lane ahead of a much slower idle lane", () => {
		const measured = [
			{ id: 0, sendRttMs: 18, lastSendOkAt: 1, lastOkAt: 1, inFlight: 1 },
			{ id: 1, sendRttMs: 40, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
		];
		const candidates = fastestSendCandidates(measured);
		expect(candidates.map((lane) => lane.id)).toEqual([0, 1]);
		expect(selectFastestSendLaneCandidate(candidates)?.id).toBe(0);
	});

	test("keeps the lowest real SEND RTT despite an in-flight stream", () => {
		const lanes = [
			{ id: 0, sendRttMs: 18, lastSendOkAt: 1, lastOkAt: 1, inFlight: 1 },
			{ id: 1, sendRttMs: 19, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
		];
		expect(selectFastestSendLaneCandidate(lanes)?.id).toBe(0);
	});

	test("uses in-flight only to break an exact RTT tie", () => {
		const lanes = [
			{ id: 0, sendRttMs: 18, lastSendOkAt: 1, lastOkAt: 1, inFlight: 2 },
			{ id: 1, sendRttMs: 18, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
		];
		expect(selectFastestSendLaneCandidate(lanes)?.id).toBe(1);
	});

	test("predicts the fastest lane independently for each bot", () => {
		const now = Date.now();
		const lanes = [
			{
				id: 0,
				sendRttMs: 18,
				sendRouteProfiles: new Map([
					["bot-a", { samples: [14, 15, 15], lastAt: now, slowUntil: 0 }],
					["bot-b", { samples: [24, 25, 25], lastAt: now, slowUntil: 0 }],
				]),
				lastSendOkAt: now,
				lastOkAt: now,
				inFlight: 0,
			},
			{
				id: 1,
				sendRttMs: 19,
				sendRouteProfiles: new Map([
					["bot-a", { samples: [20, 20, 21], lastAt: now, slowUntil: 0 }],
					["bot-b", { samples: [16, 17, 17], lastAt: now, slowUntil: 0 }],
				]),
				lastSendOkAt: now,
				lastOkAt: now,
				inFlight: 0,
			},
		];
		expect(selectFastestSendLaneCandidate(lanes, undefined, "bot-a", now)?.id).toBe(0);
		expect(selectFastestSendLaneCandidate(lanes, undefined, "bot-b", now)?.id).toBe(1);
	});

	test("does not let one bot's cooldown remove a lane for every bot", () => {
		const now = Date.now();
		const lanes = [
			{
				id: 0,
				sendRttMs: 16,
				sendRouteProfiles: new Map([["bot-a", { samples: [30], lastAt: now, slowUntil: now + 15_000 }]]),
				lastSendOkAt: now,
				lastOkAt: now,
				inFlight: 0,
			},
			{ id: 1, sendRttMs: 20, lastSendOkAt: now, lastOkAt: now, inFlight: 0 },
		];
		expect(fastestSendCandidates(lanes, "bot-a", now).map((lane) => lane.id)).toEqual([1]);
		expect(fastestSendCandidates(lanes, "bot-b", now).map((lane) => lane.id)).toEqual([0, 1]);
	});

	test("prefers a stable lane over a lower median with repeated jitter", () => {
		const lanes = [
			{ id: 0, sendRttMs: 15, sendRttSamples: [15, 15, 16, 15, 48], lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
			{ id: 1, sendRttMs: 17, sendRttSamples: [17, 17, 18, 17, 18], lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
		];
		expect(selectFastestSendLaneCandidate(lanes)?.id).toBe(1);
	});

	test("uses measured HTTP/2 capacity instead of an arbitrary in-flight penalty", () => {
		const lanes = [
			{ id: 0, sendRttMs: 15, sendRttSamples: [15], streamCapacity: 2, lastSendOkAt: 1, lastOkAt: 1, inFlight: 2 },
			{ id: 1, sendRttMs: 18, sendRttSamples: [18], streamCapacity: 2, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
		];
		expect(selectFastestSendLaneCandidate(lanes)?.id).toBe(1);
		lanes[0]!.inFlight = 1;
		expect(selectFastestSendLaneCandidate(lanes)?.id).toBe(0);
	});

	test("keeps a route above 23ms out while a non-cooling alternative exists", () => {
		const lanes = [
			{ id: 0, sendRttMs: 18, sendSlowUntil: Date.now() + 20_000, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
			{ id: 1, sendRttMs: 21, sendSlowUntil: 0, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
		];
		expect(fastestSendCandidates(lanes).map((lane) => lane.id)).toEqual([1]);
	});

	test("releases soft affinity at the exact 0.10ms boundary", () => {
		// Both lanes are past SEND_PIN_EXIT_MS, so the pin never holds here —
		// this isolates the underlying round-robin tie-break at the 0.10ms
		// margin from the pin feature layered on top of it.
		const lanes = [
			{ id: 0, sendRttMs: 26, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
			{ id: 1, sendRttMs: 25.9, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
		];
		expect(selectFastestSendLaneCandidate(lanes, 0)?.id).toBe(1);
	});

	test("holds a pinned lane through a genuine tie instead of round robin", () => {
		const lanes = [
			{ id: 0, sendRttMs: 18, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
			{ id: 1, sendRttMs: 18.05, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
		];
		// Without the pin these two are within the 0.10ms tie margin and would
		// round robin; the pinned lane (proven under SEND_PIN_ENTER_MS earlier)
		// keeps every send instead.
		const picks = Array.from({ length: 4 }, () => selectFastestSendLaneCandidate(lanes, 1, "bot-pin")?.id);
		expect(picks).toEqual([1, 1, 1, 1]);
	});

	test("releases the pin once the held lane's own score reaches the exit threshold", () => {
		const lanes = [
			{ id: 0, sendRttMs: 22.95, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
			{ id: 1, sendRttMs: 23, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
		];
		// Lane 1 is pinned but has drifted to the SEND_PIN_EXIT_MS line, so the
		// tie-break falls back to ordinary round robin between the two.
		const picks = Array.from({ length: 2 }, () => selectFastestSendLaneCandidate(lanes, 1, "bot-pin-exit")?.id);
		expect(picks).toEqual([0, 1]);
	});

	test("never lets a pin override a real, non-tied improvement", () => {
		const lanes = [
			{ id: 0, sendRttMs: 18, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
			{ id: 1, sendRttMs: 19, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
		];
		// Lane 1 is pinned, but lane 0 is genuinely faster (outside the tie
		// margin) — the pin never fights a real improvement.
		expect(selectFastestSendLaneCandidate(lanes, 1, "bot-pin-override")?.id).toBe(0);
	});

	test("uses the reserved partition only before any real application result exists", () => {
		const unmeasured = [
			{ id: 0, rttMs: 8, lastOkAt: 1, inFlight: 0 },
			{ id: 1, rttMs: 5, lastOkAt: 1, inFlight: 0 },
			{ id: 2, rttMs: 3, lastOkAt: 1, inFlight: 0 },
		];
		expect(fastestSendCandidates(unmeasured).map((lane) => lane.id)).toEqual(unmeasured.map((lane) => lane.id));
	});

	test("returns [] only when there are no usable lanes at all", () => {
		expect(fastestSendCandidates([])).toEqual([]);
	});

	test("never lets POLL switch a SEND route and keeps the SEND margin", () => {
		const current = { sendRttMs: 22, lastSendOkAt: 100, lastOkAt: 100, inFlight: 0 };
		expect(shouldPreferFastestSendLane({ pollRttMs: 1, lastPollOkAt: 100, lastOkAt: 100, inFlight: 0 }, current, 0.1)).toBeFalse();
		expect(shouldPreferFastestSendLane({ sendRttMs: 21.9, lastSendOkAt: 100, lastOkAt: 100, inFlight: 0 }, current, 0.1)).toBeTrue();
		expect(shouldPreferFastestSendLane({ sendRttMs: 21.91, lastSendOkAt: 101, lastOkAt: 101, inFlight: 0 }, current, 0.1)).toBeFalse();
	});

	test("rotates sends across lanes whose scores sit within the switch margin", () => {
		const lanes = [
			{ id: 0, sendRttMs: 19, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
			{ id: 1, sendRttMs: 19, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
			{ id: 2, sendRttMs: 19.05, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
		];
		const picks = Array.from({ length: 6 }, () => selectFastestSendLaneCandidate(lanes, undefined, "bot-x")?.id);
		expect(new Set(picks)).toEqual(new Set([0, 1, 2]));
		expect(picks).toEqual([0, 1, 2, 0, 1, 2]);
	});

	test("does not rotate onto a lane that is genuinely slower than the margin", () => {
		const lanes = [
			{ id: 0, sendRttMs: 18, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
			{ id: 1, sendRttMs: 25, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
		];
		const picks = Array.from({ length: 4 }, () => selectFastestSendLaneCandidate(lanes, undefined, "bot-y")?.id);
		expect(picks).toEqual([0, 0, 0, 0]);
	});

	test("ranks a cold lane by the offline per-IP median, not its edge PING", async () => {
		const rankFile = join(tmpdir(), `legy-ip-rank-${Date.now()}.json`);
		await Bun.write(rankFile, JSON.stringify({ "10.0.0.9": 30, "10.0.0.1": 12 }));
		const previous = process.env.LINE_H2_IP_RANK_FILE;
		process.env.LINE_H2_IP_RANK_FILE = rankFile;
		stopLanes(); // drop any cached ranking so the new file is read
		try {
			const lanes = [
				{ id: 0, rttMs: 1.2, remoteAddress: "10.0.0.9", lastOkAt: 1, inFlight: 0 },
				{ id: 1, rttMs: 1.9, remoteAddress: "10.0.0.1", lastOkAt: 1, inFlight: 0 },
			];
			// Lane 0 has the lower PING but the slower measured IP; the ranking wins.
			expect(selectFastestSendLaneCandidate(lanes, undefined, "bot-z")?.id).toBe(1);
		} finally {
			if (previous === undefined) delete process.env.LINE_H2_IP_RANK_FILE;
			else process.env.LINE_H2_IP_RANK_FILE = previous;
		}
	});
});

describe("rolling lane refresh", () => {
	const now = 10_000_000;
	const old = now - 20 * 60_000;
	const young = now - 2 * 60_000;

	test("selects the oldest idle lane after its maximum age", () => {
		const lanes = [
			{ id: 0, state: "ready" as const, inFlight: 0, openedAt: old + 1_000 },
			{ id: 1, state: "ready" as const, inFlight: 0, openedAt: old },
			{ id: 2, state: "ready" as const, inFlight: 0, openedAt: young },
		];
		expect(selectAgedLaneForRecycle(lanes, now, 15 * 60_000, 0)?.id).toBe(1);
	});

	test("never refreshes an in-flight lane", () => {
		const lanes = [
			{ id: 0, state: "ready" as const, inFlight: 1, openedAt: old },
			{ id: 1, state: "ready" as const, inFlight: 0, openedAt: young },
		];
		expect(selectAgedLaneForRecycle(lanes, now, 15 * 60_000, 0)).toBeUndefined();
	});

	test("keeps a ready standby in the same reserved partition", () => {
		const lanes = [
			{ id: 0, state: "ready" as const, inFlight: 0, openedAt: old },
			{ id: 1, state: "dead" as const, inFlight: 0, openedAt: old },
			{ id: 2, state: "ready" as const, inFlight: 0, openedAt: old },
			{ id: 3, state: "ready" as const, inFlight: 0, openedAt: young },
		];
		// Lanes 0-1 are reserved for sends. Lane 0 must stay up because lane 1
		// is dead; an old poll lane can still be refreshed safely.
		expect(selectAgedLaneForRecycle(lanes, now, 15 * 60_000, 2)?.id).toBe(2);
	});

	test("can be disabled with a zero maximum age", () => {
		const lanes = [
			{ id: 0, state: "ready" as const, inFlight: 0, openedAt: old },
			{ id: 1, state: "ready" as const, inFlight: 0, openedAt: old },
		];
		expect(selectAgedLaneForRecycle(lanes, now, 0, 0)).toBeUndefined();
	});
});

describe("degraded lane repair", () => {
	test("picks the worst degraded, idle lane over a merely mediocre one", () => {
		const lanes = [
			{ id: 0, state: "ready" as const, inFlight: 0, sendRttMs: 19, degraded: false },
			{ id: 1, state: "ready" as const, inFlight: 0, sendRttMs: 41, degraded: true },
			{ id: 2, state: "ready" as const, inFlight: 0, sendRttMs: 26, degraded: true },
		];
		expect(selectDegradedLaneForRepair(lanes)?.id).toBe(1);
	});

	test("never repairs the pool's own fastest lane even if somehow flagged", () => {
		const lanes = [
			{ id: 0, state: "ready" as const, inFlight: 0, sendRttMs: 18, degraded: true },
			{ id: 1, state: "ready" as const, inFlight: 0, sendRttMs: 20, degraded: false },
		];
		expect(selectDegradedLaneForRepair(lanes)).toBeUndefined();
	});

	test("never repairs a lane with a request still in flight", () => {
		const lanes = [
			{ id: 0, state: "ready" as const, inFlight: 0, sendRttMs: 19, degraded: false },
			{ id: 1, state: "ready" as const, inFlight: 1, sendRttMs: 40, degraded: true },
		];
		expect(selectDegradedLaneForRepair(lanes)).toBeUndefined();
	});

	test("does nothing below the minimum measured-lane count", () => {
		const lanes = [{ id: 0, state: "ready" as const, inFlight: 0, sendRttMs: 40, degraded: true }];
		expect(selectDegradedLaneForRepair(lanes)).toBeUndefined();
	});

	test("does nothing when no lane is flagged degraded", () => {
		const lanes = [
			{ id: 0, state: "ready" as const, inFlight: 0, sendRttMs: 19, degraded: false },
			{ id: 1, state: "ready" as const, inFlight: 0, sendRttMs: 24, degraded: false },
		];
		expect(selectDegradedLaneForRepair(lanes)).toBeUndefined();
	});

	test("ignores a lane that is not actually ready", () => {
		const lanes = [
			{ id: 0, state: "ready" as const, inFlight: 0, sendRttMs: 19, degraded: false },
			{ id: 1, state: "draining" as const, inFlight: 0, sendRttMs: 40, degraded: true },
		];
		expect(selectDegradedLaneForRepair(lanes)).toBeUndefined();
	});
});

describe("lane request encoding", () => {
	test("drops HTTP/1 connection headers and asks for an identity body", () => {
		const headers = buildHeaders("legy.line-apps.com", "https", "/SQ1", "POST", {
			headers: {
				Host: "legy.line-apps.com",
				Connection: "keep-alive",
				"Transfer-Encoding": "chunked",
				"accept-encoding": "gzip",
				[H2_LANE_ROLE_HEADER]: "send",
				[H2_LANE_ROUTE_KEY_HEADER]: "bot-12",
				"x-line-access": "token",
			},
		});

		expect(headers[":authority"]).toBe("legy.line-apps.com");
		expect(headers[":path"]).toBe("/SQ1");
		expect(headers["host"]).toBeUndefined();
		expect(headers["connection"]).toBeUndefined();
		expect(headers["transfer-encoding"]).toBeUndefined();
		// node:http2 does not decompress, and gzip buys nothing on an ACK.
		expect(headers["accept-encoding"]).toBe("identity");
		expect(headers[H2_LANE_ROLE_HEADER]).toBeUndefined();
		expect(headers[H2_LANE_ROUTE_KEY_HEADER]).toBeUndefined();
		expect(headers["x-line-access"]).toBe("token");
	});

	test("still decodes a compressed reply if LINE sends one anyway", () => {
		const payload = new Uint8Array([0x82, 0x21, 0x00, 0x0b]);
		expect(decodeBody(new Uint8Array(gzipSync(payload)), "gzip")).toEqual(payload);
		expect(decodeBody(payload, undefined)).toEqual(payload);
		expect(decodeBody(payload, "identity")).toEqual(payload);
	});
});
