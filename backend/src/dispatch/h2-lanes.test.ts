import { afterEach, describe, expect, test } from "bun:test";
import { createServer, constants, type Http2Server, type ServerHttp2Stream, type IncomingHttpHeaders } from "node:http2";
import { gzipSync } from "node:zlib";
import {
	buildHeaders,
	decodeBody,
	ensureLanes,
	fastestSendCandidates,
	H2_LANE_ROLE_HEADER,
	laneCandidates,
	laneFetch,
	laneStats,
	pollingCandidatesForCalibration,
	primeLanes,
	selectAgedLaneForRecycle,
	selectPollingLaneCandidate,
	shouldPreferFastestSendLane,
	shouldPreferLane,
	shouldPreferRemoteLane,
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

	test("keeps exactly one lane carrying traffic so a send is never duplicated", async () => {
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
		const used = laneStats().filter((lane) => lane.lastOkAt > 0);
		expect(used).toHaveLength(1);
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
		expect(sendSession).toBe(primeSession);
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
	test("chooses Server 3 only when its real result is faster", () => {
		const local = { sendRttMs: 24, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 };
		expect(shouldPreferRemoteLane({ sendRttMs: 19, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 }, local)).toBe(true);
		expect(shouldPreferRemoteLane({ sendRttMs: 31, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 }, local)).toBe(false);
	});

	test("bootstraps an unmeasured Server 3 by relative PING, not an absolute ceiling", () => {
		const local = { rttMs: 12, sendRttMs: 25, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 };
		expect(shouldPreferRemoteLane({ rttMs: 8, lastOkAt: 1, inFlight: 0 }, local)).toBe(true);
		expect(shouldPreferRemoteLane({ rttMs: 15, lastOkAt: 1, inFlight: 0 }, local)).toBe(false);
		expect(shouldPreferRemoteLane({ rttMs: 50, lastOkAt: 1, inFlight: 0 }, undefined)).toBe(true);
	});

	test("prefers a materially faster route even after accounting for one in-flight stream", () => {
		expect(shouldPreferLane({ rttMs: 1.0, lastOkAt: 10, inFlight: 1 }, { rttMs: 8.0, lastOkAt: 20, inFlight: 0 }, "send")).toBeTrue();
	});

	test("does not chase a slightly faster ping when that lane is occupied", () => {
		expect(shouldPreferLane({ rttMs: 2.3, lastOkAt: 10, inFlight: 1 }, { rttMs: 5.6, lastOkAt: 20, inFlight: 0 }, "send")).toBeFalse();
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
		expect(shouldPreferLane({ rttMs: 2.3, lastOkAt: 10, inFlight: 0 }, { rttMs: 2.8, lastOkAt: 20, inFlight: 0 }, "send")).toBeFalse();
		expect(shouldPreferLane({ rttMs: 2.3, lastOkAt: 10, inFlight: 0 }, { rttMs: 2.8, lastOkAt: 20, inFlight: 1 }, "poll")).toBeTrue();
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

	test("keeps all idle measured send candidates regardless of absolute RTT", () => {
		const measured = [
			{ id: 0, sendRttMs: 80, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
			{ id: 1, sendRttMs: 95, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
			{ id: 2, pollRttMs: 70, lastPollOkAt: 1, lastOkAt: 1, inFlight: 0 },
			{ id: 3, pollRttMs: 60, lastPollOkAt: 1, lastOkAt: 1, inFlight: 1 },
		];
		expect(fastestSendCandidates(measured).map((lane) => lane.id)).toEqual([0, 1, 2]);
	});

	test("uses an idle measured route instead of queueing behind the fastest occupied route", () => {
		const measured = [
			{ id: 0, sendRttMs: 18, lastSendOkAt: 1, lastOkAt: 1, inFlight: 1 },
			{ id: 1, sendRttMs: 40, lastSendOkAt: 1, lastOkAt: 1, inFlight: 0 },
		];
		expect(fastestSendCandidates(measured).map((lane) => lane.id)).toEqual([1]);
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

	test("switches at exactly 0.50ms but not at 0.49ms", () => {
		const current = { sendRttMs: 22, lastSendOkAt: 100, lastOkAt: 100, inFlight: 0 };
		expect(shouldPreferFastestSendLane({ pollRttMs: 21.5, lastPollOkAt: 100, lastOkAt: 100, inFlight: 0 }, current, 0.5)).toBeTrue();
		expect(shouldPreferFastestSendLane({ pollRttMs: 21.51, lastPollOkAt: 101, lastOkAt: 101, inFlight: 0 }, current, 0.5)).toBeFalse();
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

describe("lane request encoding", () => {
	test("drops HTTP/1 connection headers and asks for an identity body", () => {
		const headers = buildHeaders("legy.line-apps.com", "https", "/SQ1", "POST", {
			headers: {
				Host: "legy.line-apps.com",
				Connection: "keep-alive",
				"Transfer-Encoding": "chunked",
				"accept-encoding": "gzip",
				[H2_LANE_ROLE_HEADER]: "send",
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
		expect(headers["x-line-access"]).toBe("token");
	});

	test("still decodes a compressed reply if LINE sends one anyway", () => {
		const payload = new Uint8Array([0x82, 0x21, 0x00, 0x0b]);
		expect(decodeBody(new Uint8Array(gzipSync(payload)), "gzip")).toEqual(payload);
		expect(decodeBody(payload, undefined)).toEqual(payload);
		expect(decodeBody(payload, "identity")).toEqual(payload);
	});
});
