import type { BaseClient } from "../core/mod.ts";
import { LegyH2PingFrame, LegyH2PingFrameType, LegyH2PushFrame, LegyH2PushFrameType, LegyH2SignOnResponseFrame } from "./connData.ts";
import type { ConnManager } from "./connManager.ts";
import { connect as connectHttp2, type ClientHttp2Session, type ClientHttp2Stream, type OutgoingHttpHeaders } from "node:http2";

interface PushRequestWriter {
	enqueue(chunk: Uint8Array): void;
	close(): void;
	error(error: unknown): void;
	abort: AbortController;
}

export class Conn {
	manager: ConnManager;

	h2Headers: Array<[string, string]> = [];
	isNotFinished = false;
	cacheData: Uint8Array = new Uint8Array(0);
	notFinPayloads: Record<number, Uint8Array> = {};
	reqStream?: PushRequestWriter;
	private readDone?: Promise<void>;
	private _lastSendTime = 0;
	private _closed = false;
	private h2Session?: ClientHttp2Session;
	private h2Request?: ClientHttp2Stream;

	constructor(manager: ConnManager) {
		this.manager = manager;
	}

	get client(): BaseClient {
		return this.manager.client;
	}

	async new(host: string, _port: number, path: string, headers: Record<string, string> = {}) {
		// Bun fetch negotiates h2 but does not reliably expose LINE's response
		// while this bidirectional request body remains open on Windows. The
		// node:http2 implementation bundled by Bun does true full-duplex I/O
		// and keeps the long-lived PUSH stream independent of RPC transport.
		const abort = new AbortController();
		this._closed = false;
		const session = connectHttp2(`https://${host}`);
		this.h2Session = session;
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("HTTP/2 push connect timeout")), 10_000);
			const connected = () => {
				clearTimeout(timeout);
				session.off("error", failed);
				resolve();
			};
			const failed = (error: Error) => {
				clearTimeout(timeout);
				session.off("connect", connected);
				reject(error);
			};
			session.once("connect", connected);
			session.once("error", failed);
		});

		const requestHeaders: OutgoingHttpHeaders = {
			":method": "POST",
			":path": path,
			":scheme": "https",
			":authority": host,
		};
		for (const [key, value] of Object.entries(headers)) {
			const lower = key.toLowerCase();
			if (lower === "host" || lower === "connection" || lower === "transfer-encoding") continue;
			requestHeaders[lower] = value;
		}

		const request = session.request(requestHeaders, { endStream: false });
		this.h2Request = request;
		// Parse directly inside node:http2's data callback. The former
		// data -> Web ReadableStream -> async iterator route added a scheduler
		// hop and queue allocation before every message, outside the dashboard's
		// old CODE timestamp.
		this.readDone = new Promise<void>((resolveRead, rejectRead) => {
			let settled = false;
			const fail = (error: unknown) => {
				if (settled) return;
				settled = true;
				rejectRead(error instanceof Error ? error : new Error(String(error)));
			};
			request.once("response", (responseHeaders) => {
				this.h2Headers = Object.entries(responseHeaders).filter((entry): entry is [string, string] => typeof entry[1] === "string");
				const status = Number(responseHeaders[":status"] ?? 0);
				if (status >= 400) fail(new Error(`LINE push HTTP ${status}`));
			});
			request.on("data", (chunk: Uint8Array) => {
				if (settled) return;
				try {
					if (this.client.debugLogsEnabled) this.manager.log("readByte", chunk);
					this.onDataReceived(chunk);
				} catch (error) {
					fail(error);
					request.destroy(error instanceof Error ? error : new Error(String(error)));
				}
			});
			request.once("end", () => {
				if (settled) return;
				settled = true;
				resolveRead();
			});
			request.once("error", fail);
			// A self-initiated RST (Conn.close(), called both for a normal
			// teardown and as session-manager.ts's stall-recovery repair) or a
			// peer-initiated one can settle the stream with only a `close`
			// event -- no `end`, no `error` -- the same lesson h2-lanes.ts's
			// sendOnLane already learned about Bun's http2 client ("close
			// always comes last and always carries it"). Without this listener
			// `readDone` never settles, `Conn.read()` hangs forever, and
			// `initLegyPusher()`'s reconnect loop in polling/mod.ts -- whose
			// catch/finally is what actually splices out the dead conn and
			// retries -- never runs: the very first recovery attempt
			// permanently kills the push connection instead of replacing it.
			request.once("close", () => fail(new Error("push stream closed")));
		});
		abort.signal.addEventListener(
			"abort",
			() => {
				request.close();
				session.close();
			},
			{ once: true },
		);
		this.reqStream = {
			enqueue: (chunk) => request.write(chunk),
			close: () => request.end(),
			error: (error) => request.destroy(error instanceof Error ? error : new Error(String(error))),
			abort,
		};
	}

	async writeByte(data: Uint8Array) {
		if (!this.reqStream) {
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 500);
			});
			if (!this.reqStream) {
				throw new Error("no reqStream");
			}
		}
		this.manager.log("writeByte", data);
		this.reqStream.enqueue(data);
	}

	async writeRequest(requestType: number, data: Uint8Array) {
		const d = this.manager.buildRequest(requestType, data);
		await this.writeByte(d);
	}

	async read() {
		if (!this.readDone) throw new Error("push response stream was not created");
		await this.readDone;
	}

	isAble2Request(): boolean {
		if (this.client.authToken && !this._closed) {
			if (Date.now() / 1000 - this._lastSendTime > 0.5) return true;
		}
		return false;
	}

	readPacketHeader(data: Uint8Array): { dt: number; dd: Uint8Array; dl: number } {
		const dl = (data[0] << 8) | data[1];
		const dt = data[2];
		const dd = data.subarray(3); // WHAT:
		return { dt, dd, dl };
	}

	onDataReceived(data: Uint8Array): void {
		if (this.isNotFinished) {
			const concat = new Uint8Array(this.cacheData.length + data.length);
			concat.set(this.cacheData);
			concat.set(data, this.cacheData.length);
			data = concat;
		}
		if (this.client.debugLogsEnabled) {
			this.manager.log(`[H2][PUSH] receives packet. raw:${bytesToHex(data)}`, true);
		}
		const { dt, dd, dl } = this.readPacketHeader(data);
		if (dl > dd.length) {
			this.isNotFinished = true;
			this.cacheData = data;
			return;
		} else {
			this.isNotFinished = false;
			if (dd.length > dl) {
				this.onPacketReceived(dt, dd.subarray(0, dl));
				const rest = dd.subarray(dl);
				if (this.client.debugLogsEnabled) {
					this.manager.log(`[PUSH] extra data ${bytesToHex(rest).slice(0, 50)}...`, true);
				}
				return this.onDataReceived(rest);
			}
		}
		this.onPacketReceived(dt, dd);
	}

	onPacketReceived(dt: number, dd: Uint8Array) {
		const debugOnly = true;
		if (dt === 1) {
			const pingType = dd[0];
			const pingId = (dd[1] << 8) | dd[2];
			const packet = new LegyH2PingFrame(pingType, pingId);
			this.manager.log(`[PUSH] receives ping frame. pingId:${packet.pingId}`, debugOnly);
			if (packet.pingType === LegyH2PingFrameType.ACK_REQUIRED) {
				// Fire-and-forget from this synchronous handler — a rejection
				// (e.g. `writeByte`'s "no reqStream" during a reconnect race)
				// would otherwise be an unhandled promise rejection instead of
				// a reported push failure.
				this.writeByte(packet.ackPacket()).catch((error: unknown) => {
					this.manager.log("PushAckError", {
						at: "ping ack",
						error: error instanceof Error ? error.message : String(error),
					});
				});
				this.manager.log(`[PUSH] send ping ack. pingId:${pingId}`, debugOnly);
				this.manager.onPingCallback(pingId);
			} else {
				throw new Error(`ping type not Implemented: ${pingType}`);
			}
		} else if (dt === 3) {
			const req = (dd[0] << 8) | dd[1];
			const requestId = req & 0x7fff;
			const isFin = (req & 0x8000) !== 0;
			let responsePayload = dd.subarray(2);
			const packet = new LegyH2SignOnResponseFrame(requestId, isFin, responsePayload);
			if (packet.isFin) {
				if (this.notFinPayloads[requestId]) {
					const a = this.notFinPayloads[requestId];
					const newPayload = new Uint8Array(a.length + responsePayload.length);
					newPayload.set(a);
					newPayload.set(responsePayload, a.length);
					responsePayload = newPayload;
					delete this.notFinPayloads[requestId];
				}
				this.manager.onSignOnResponse(requestId, isFin, responsePayload);
			} else {
				this.manager.log(`[PUSH] receives long data. requestId: ${requestId}, req=${req}`, debugOnly);
				if (!this.notFinPayloads[requestId]) {
					this.notFinPayloads[requestId] = new Uint8Array(0);
				}
				const prev = this.notFinPayloads[requestId];
				const combined = new Uint8Array(prev.length + responsePayload.length);
				combined.set(prev);
				combined.set(responsePayload, prev.length);
				this.notFinPayloads[requestId] = combined;
			}
		} else if (dt === 4) {
			const pushType = dd[0];
			const serviceType = dd[1];
			const pushId = (dd[2] << 24) | (dd[3] << 16) | (dd[4] << 8) | dd[5];
			const pushPayload = dd.subarray(6);
			const packet = new LegyH2PushFrame(pushType, serviceType, pushId, pushPayload);
			this.manager.log(`[PUSH] receives push frame. service:${packet.serviceType}`, debugOnly);
			if ([LegyH2PushFrameType.NONE, LegyH2PushFrameType.ACK_REQUIRED].includes(packet.pushType!)) {
				if (packet.pushType === LegyH2PushFrameType.ACK_REQUIRED) {
					// See the matching comment on the ping-ack write above.
					this.writeByte(packet.ackPacket()).catch((error: unknown) => {
						this.manager.log("PushAckError", {
							at: "push ack",
							service: serviceType,
							error: error instanceof Error ? error.message : String(error),
						});
					});
					this.manager.log(`[PUSH] send push ack. service:${serviceType}`, debugOnly);
				}
				this.manager.onPushResponse(packet);
			} else {
				throw new Error(`push type not Implemented: ${pushType}`);
			}
		} else {
			throw new Error(`PUSH not Implemented: type:${dt}, payloads:${bytesToHex(dd).slice(0, 30)}, len:${dd.length}`);
		}
	}

	async close() {
		await 0;
		this._closed = true;
		try {
			this.reqStream?.close();
			this.reqStream?.abort.abort();
			this.h2Request?.close();
			this.h2Session?.close();
		} catch (_e) {
			// ignore
		}
	}
}

/* helpers */
function bytesToHex(b: Uint8Array) {
	return Array.from(b)
		.map((x) => x.toString(16).padStart(2, "0"))
		.join("");
}
