import type { LegyH2PushFrame } from "./connData.ts";
import { Conn } from "./conn.ts";
import { SquareRearmPolicy } from "./rearm_policy.ts";
import { AsyncQueue } from "../async-queue.ts";
import type { BaseClient } from "../mod.ts";
import { TCompactProtocol } from "thrift";

import { TMoreCompactProtocol } from "../thrift/readwrite/tmc.ts";

// GOMI:
import {
	type PartialDeep,
	SquareService_fetchMyEvents_args as gen_SquareService_fetchMyEvents_args,
	sync_args as gen_sync_args,
} from "../thrift/readwrite/struct.ts";

import type {
	Operation,
	SquareEvent,
	SquareService_fetchMyEvents_args,
	SquareService_fetchMyEvents_result,
	sync_args,
	sync_result,
} from "@evex/linejs-types";

import type { ParsedThrift } from "../thrift/mod.ts";
import { Buffer } from "node:buffer";
import type { LooseType } from "@evex/loose-types";

function gen_m(ss = [1, 3, 5, 6, 8, 9, 10]) {
	let i = 0;
	for (const s of ss) i |= 1 << (s - 1);
	return i;
}

/**
 * Escape hatch for the square re-arm below, so it can be switched off in
 * a running deployment without a rebuild.
 */
const SQUARE_REARM_ENABLED = globalThis.process?.env?.SQUARE_PUSH_REARM !== "0";

export interface ReadableStreamWriter<T> {
	stream: ReadableStream<T>;
	enqueue(chunk: T): void;
	close(): void;
	error(err: LooseType): void;
	renew(): void;
}
export class ConnManager {
	client: BaseClient;
	conns: Conn[] = [];
	currPingId = 0;
	subscriptionIds: Record<number, number> = {};
	signOnRequests: Record<number, LooseType[]> = {};
	/**
	 * Wire request id is 15 bits — `conn.ts`'s response parser reserves bit
	 * 0x8000 for `isFin` (`requestId = req & 0x7fff`), so any id at or above
	 * 32768 corrupts that flag on the frame that echoes it back. The old
	 * `Object.keys(this.signOnRequests).length + 1` scheme both leaked (no
	 * entry was ever pruned after its response arrived) and had no ceiling,
	 * so a long-lived connection eventually wrapped past this limit and
	 * aliased a brand-new request onto a stale, still-present entry with an
	 * unrelated serviceType — see the pruning in `_OnSignOnResponse`.
	 */
	#nextSignOnRequestId = 0;
	onPingCallback: (id: number) => void;
	onSignReqResp: Record<number, LooseType> = {};
	onSignOnResponse: (reqId: number, isFin: boolean, data: Uint8Array) => void;
	onPushResponse: (frame: LegyH2PushFrame) => void;
	_eventSynced = false;
	_pingInterval = 30;
	/** Decides whether keeping a square fetch armed is still safe. */
	readonly #squareRearm = new SquareRearmPolicy();
	/**
	 * Serializes every square-event fetch response through one queue.
	 *
	 * Two independent paths both fetch square events: a push notification
	 * (`_OnPushResponse`) and the rearm-armed long-poll (`_OnSignOnResponse`,
	 * serviceType 3). Both read `client.poll.sync.square`, fetch events
	 * since it, enqueue them, then write the new token back — and nothing
	 * stopped the two overlapping. A push firing while a rearm response was
	 * still in flight let both read the same token, fetch from the same
	 * starting point, and whichever finished last won the write — sometimes
	 * advancing the token past a range the *other* fetch's response held,
	 * silently dropping those events. Quiet rooms rarely trigger the
	 * overlap (one fetch settles long before the next event exists to
	 * notify about); rooms with several senders posting within moments of
	 * each other trigger it far more often.
	 */
	readonly #squareFetchQueue = new AsyncQueue();
	authToken: string | null = null;
	subscriptionId: number = 0;
	/**
	 * Wall-clock time of the last square fetch response, success or empty —
	 * updated by both delivery paths (`_OnSignOnResponse`'s re-arm chain and
	 * `_OnPushResponse`). The re-arm chain is self-perpetuating only as long
	 * as each response successfully re-arms the next one; if a single link
	 * fails silently (a write that hangs rather than rejects, for instance),
	 * nothing here throws or logs — the bot simply stops hearing OpenChat
	 * without the watchdog's own `noop()` probe ever noticing, since the
	 * credential and connection both remain otherwise healthy. Callers
	 * outside this class poll this timestamp to detect exactly that silent
	 * failure and force a reconnect — see session-manager.ts's square
	 * staleness watchdog.
	 */
	lastSquareFetchAt: number = Date.now();

	opStream: ReadableStreamWriter<Operation>;
	sqStream: ReadableStreamWriter<SquareEvent>;

	constructor(base: BaseClient) {
		this.client = base;
		this.onPingCallback = this._OnPingCallback.bind(this);
		this.onSignOnResponse = this._OnSignOnResponse.bind(this);
		this.onPushResponse = this._OnPushResponse.bind(this);
		this.opStream = this.createAsyncReadableStream<Operation>();
		this.sqStream = this.createAsyncReadableStream<SquareEvent>();
	}

	log(text: string, data?: LooseType) {
		// PushAckError deliberately excluded from `failure`: it means one ack
		// write raced a reconnect (usually `writeByte`'s "no reqStream" while
		// `reqStream` is momentarily unset), which is not on its own evidence
		// the session is unhealthy the way a failed `noop()` or `fetchMyEvents`
		// is — those already have their own dedicated failure labels below.
		// Catching and logging it here only needs to stop it from being an
		// anonymous unhandled rejection; it does not need to raise a
		// dashboard-visible error on every transient race.
		const failure =
			text === "SignOnResponseError" ||
			text === "PushResponseError" ||
			text === "LegyPusherError" ||
			text === "LegyPusherError_cannot_init";
		// These lines are useful while diagnosing an event-stream issue, but a
		// healthy fast poll can produce them many times per second. Emitting
		// them to journald continuously adds scheduler and disk contention to
		// the reply process, so diagnostics are explicitly opt-in. Failures
		// remain visible regardless of this flag.
		const diagnostic =
			text === "SQ_fetchMyEvents" ||
			text === "SquareRearmSkipped" ||
			text === "SquareRearmError" ||
			text === "SquareRearmForced" ||
			text.startsWith("response fetchMyEvent(");
		const squareDiagnosticsEnabled = globalThis.process?.env?.LINEJS_SQUARE_DIAGNOSTICS === "1";
		if (!failure && !this.client.debugLogsEnabled && !(diagnostic && squareDiagnosticsEnabled)) return;
		this.client.log(failure ? text : diagnostic ? "[SQ_DIAG] " + text : "[LEGY/PUSH] " + text, data ?? "");
	}

	createAsyncReadableStream<T>(): ReadableStreamWriter<T> {
		let controller: ReadableStreamDefaultController<T> | null = null;

		const chunks: T[] = [];
		const stream = new ReadableStream<T>(
			{
				start(c) {
					controller = c;
				},
				pull(c) {
					if (chunks.length) {
						c.enqueue(chunks.shift()!);
					}
				},
				cancel() {
					controller = null;
					writer.renew();
				},
			},
			{
				highWaterMark: 200,
				size() {
					return 1;
				},
			},
		);

		const writer = {
			stream,
			enqueue(chunk: T) {
				const data = chunk;
				if (controller && (controller.desiredSize ?? 0) > 0) {
					controller.enqueue(data);
				} else {
					chunks.push(data);
				}
			},
			close() {
				controller?.close();
				controller = null;
				this.renew();
			},
			error(err: LooseType) {
				controller?.error(err);
				controller = null;
				this.renew();
			},
			renew() {
				this.stream = new ReadableStream<T>(
					{
						start(c) {
							controller = c;
						},
						pull(c) {
							if (chunks.length) {
								c.enqueue(chunks.shift()!);
							}
						},
						cancel() {
							controller = null;
						},
					},
					{
						highWaterMark: 200,
						size() {
							return 1;
						},
					},
				);
			},
		};
		return writer;
	}

	async initializeConn(state = 1, initServices = [3, 6, 8, 9, 10]): Promise<Conn> {
		const _conn = new Conn(this);
		this.signOnRequests = {};
		if (state === 1) {
			this.conns[0] = _conn;
			this.authToken = this.client.authToken!;
		}
		const tosendHeaders: Record<string, string> = this.client.request.getHeader();
		tosendHeaders["content-type"] = "application/octet-stream";
		tosendHeaders["accept"] = "application/octet-stream";
		const m = gen_m(initServices);
		this.log(`Using \`m=${m}\` on \`/PUSH\``);
		const host = this.client.request.endpoint;
		const port = 443;
		await _conn.new(host, port, `/PUSH/1/subs?m=${m}`, tosendHeaders);
		return _conn;
	}

	buildRequest(service: number, data: Uint8Array): Uint8Array {
		const len = data.length;
		const out = new Uint8Array(2 + 1 + len);
		out[0] = (len >> 8) & 0xff;
		out[1] = len & 0xff;
		out[2] = service & 0xff;
		out.set(data, 3);
		return out;
	}

	async buildAndSendSignOnRequest(
		conn: Conn,
		serviceType: number,
		kwargs: Record<string, LooseType> = {},
	): Promise<{ payload: Uint8Array<ArrayBuffer>; id: number }> {
		this.log("buildAndSendSignOnRequest", { serviceType, kwargs });
		const cl = this.client;
		this.#nextSignOnRequestId = (this.#nextSignOnRequestId % 0x7fff) + 1;
		const id = this.#nextSignOnRequestId;
		const idBuf = new Uint8Array(2);
		idBuf[0] = (id >> 8) & 0xff;
		idBuf[1] = id & 0xff;
		let methodName: string | undefined;
		// build payload body depending on serviceType
		let req: Uint8Array = new Uint8Array(0);
		if (serviceType === 3) {
			// fetchMyEvents - delegate to client generator
			req = cl.thrift.writeThrift(
				gen_SquareService_fetchMyEvents_args(kwargs as PartialDeep<SquareService_fetchMyEvents_args>),
				"fetchMyEvents",
				TCompactProtocol,
			);
			methodName = "fetchMyEvents";
		} else if ([5, 8].includes(serviceType)) {
			req = cl.thrift.writeThrift(gen_sync_args(kwargs as PartialDeep<sync_args>), "sync", TCompactProtocol);
			methodName = "sync";
		}
		const header = new Uint8Array(2 + 1 + 1 + 2 + req.length);
		header.set(idBuf, 0);
		header[2] = serviceType & 0xff;
		header[3] = 0;
		header[4] = (req.length >> 8) & 0xff;
		header[5] = req.length & 0xff;
		header.set(req, 6);
		this.signOnRequests[id] = [serviceType, methodName, null];
		this.log(`[H2][PUSH] send sign-on-request. requestId:${id}, service:${serviceType}`);
		await conn.writeRequest(2, header);
		return { payload: header, id };
	}

	async _OnSignOnResponse(reqId: number, isFin: boolean, data: Uint8Array): Promise<false | undefined> {
		// data = data.slice(5);
		const cl = this.client;
		if (!(reqId in this.signOnRequests)) {
			this.log(`[PUSH] unknown sign-on-response requestId:${reqId}`);
			return;
		}
		const entry = this.signOnRequests[reqId];
		const serviceType: number = entry[0];
		const methodName: string | undefined = entry[1];
		// A fin frame is the only response this reqId will ever get (see
		// conn.ts's isFin handling) — pruning here is what keeps the id
		// space from silently reusing a still-live entry once the 15-bit
		// counter above wraps.
		delete this.signOnRequests[reqId];

		this.log(`receives sign-on-response frame. requestId:${reqId}, service:${serviceType}, isFin:${isFin}, payload:${data.length}`);

		try {
			// service 3: Square.fetchMyEvents
			if (serviceType === 3) {
				const resp: SquareService_fetchMyEvents_result = cl.thrift.rename_data(cl.thrift.readThrift(data, TCompactProtocol), true).data;
				// validate resp similarly to Python

				if (resp.e) {
					this.log(`can't use PUSH for OpenChat:${resp.e.errorCode}`, resp.e);
					return false;
				}
				// A response arrived — the re-arm chain is alive, whether or not it
				// carried events. Marked before the queue below so a slow queue
				// (another response still processing) never reads as staleness.
				this.lastSquareFetchAt = Date.now();
				// use client's helpers to pick values (mirror Python checkAndGetValue)

				// Everything that reads or writes `poll.sync.square` runs inside
				// the shared queue — see `#squareFetchQueue` — so a push
				// notification landing mid-processing here cannot read this
				// response's pre-write token and race the write below.
				let rearm: { subscriptionId: number; syncToken: string; eventCount: number } | undefined;
				await this.#squareFetchQueue.run(async () => {
					const {
						subscription: { subscriptionId },
						events,
						syncToken,
					} = resp.success;

					if (this.client.debugLogsEnabled) {
						this.client.log("SquareService_fetchMyEvents_result", {
							res: resp.success,
						});
					}

					if (!Array.isArray(events)) {
						throw new Error(`events should be list: ${events}`);
					}
					if (typeof syncToken !== "string") {
						throw new Error(`syncToken should be str: ${syncToken}`);
					}
					// Empty re-arm responses are routine and can arrive dozens of times
					// per second. Writing every one to journald competes with the event
					// loop that must notice the one non-empty response immediately.
					if (events.length > 0 || this.client.debugLogsEnabled) {
						this.log(`response fetchMyEvent(${subscriptionId}) events:${events.length}, syncToken:${syncToken}`);
					}
					if (typeof subscriptionId !== "number") {
						throw new Error(`subscriptionId should be int: ${subscriptionId}`);
					}

					if (subscriptionId != null) {
						this.subscriptionIds[subscriptionId] = Date.now() / 1000;
					}

					for (const ev of events) {
						this.sqStream.enqueue(ev);
					}

					if (this.client.poll.sync.square !== syncToken) {
						this.client.poll.sync.square = syncToken;
						this.client.emit("update:syncdata", this.client.poll.sync);
					}
					this.subscriptionId = subscriptionId;

					if (!this._eventSynced) {
						this.log(`myEvents start(${subscriptionId}) : syncToken:${syncToken}`);
						this._eventSynced = true;
					}

					rearm = { subscriptionId, syncToken, eventCount: events.length };
				});

				// Sending the next long-poll request doesn't touch the shared
				// token, so it doesn't need to wait in the same queue — firing
				// it the moment this response is processed keeps rearm latency
				// unchanged.
				if (rearm) await this.#rearmSquareFetch(rearm.subscriptionId, rearm.syncToken, rearm.eventCount);
				return;
			} else if ([5, 8].includes(serviceType)) {
				// Talk: may be sync or fetchOps
				const _conn = this.conns[0];
				// try to parse TMoreCompact-like response first if available
				let parsed: ParsedThrift | null = null;
				let detectedMethod = methodName;
				try {
					const proto = new TMoreCompactProtocol(Buffer.from(data));
					parsed = <LooseType>{
						data: proto.res,
						_info: {
							fname: detectedMethod,
						},
					};
					cl.thrift.rename_data(parsed!);

					if (parsed!.data.e) {
						this.log("sync error:", parsed!.data.e);
					}
				} catch (e) {
					// ignore and let outer handler manage
					this.log(`[PUSH] parse error: ${e}`);
					try {
						parsed = cl.thrift.readThrift(data, TCompactProtocol);
					} catch (_) {
						return false;
					}
				}

				if (!detectedMethod && parsed) {
					detectedMethod = parsed._info.fname;
				}

				if (detectedMethod === "sync" && parsed) {
					// handle sync response flow

					const res: sync_result = parsed.data;
					// Mirrors the `resp.e` check on the square branch above: `sync_result`
					// is a thrift union, and a `TalkException` response left `res.success`
					// undefined here. Reading `.fullSyncResponse` off that unconditionally
					// is exactly the `response.fullSyncResponse` crash logged as
					// `SignOnResponseError` — and because it threw before reaching the
					// re-arm send below, the talk sync chain then died silently.
					if (res.e) {
						this.log(`can't process talk sync:${res.e.code}`, res.e);
						return false;
					}
					const response = res.success;

					if (this.client.debugLogsEnabled) {
						this.client.log("sync_result", { res });
					}

					if (response.fullSyncResponse && response.fullSyncResponse.nextRevision) {
						this.client.poll.sync.talk.revision = response.fullSyncResponse.nextRevision;
					}
					if (
						response.operationResponse &&
						response.operationResponse.globalEvents &&
						response.operationResponse.globalEvents.lastRevision
					) {
						this.client.poll.sync.talk.globalRev = response.operationResponse.globalEvents.lastRevision;
					}
					if (
						response.operationResponse &&
						response.operationResponse.individualEvents &&
						response.operationResponse.individualEvents.lastRevision
					) {
						this.client.poll.sync.talk.individualRev = response.operationResponse.individualEvents.lastRevision;
					}
					if (response.operationResponse && response.operationResponse.operations) {
						for (const event of response.operationResponse.operations) {
							this.client.poll.sync.talk.revision = event.revision;
							this.opStream.enqueue(event);
						}
					}

					this.client.emit("update:syncdata", this.client.poll.sync);

					const ex_val: PartialDeep<sync_args> = {
						request: {
							lastRevision: this.client.poll.sync.talk.revision,
							count: 100,
							lastGlobalRevision: this.client.poll.sync.talk.globalRev,
							lastIndividualRevision: this.client.poll.sync.talk.individualRev,
						},
					};

					this.log(`request talk fetcher:`, ex_val);
					await this.buildAndSendSignOnRequest(_conn, serviceType, ex_val);
					return;
				} /*else if (detectedMethod === "fetchOps") {
					// handle fetchOps response
					const ops = resp;
					if (!Array.isArray(ops)) {
						throw new Error(`ops should be list: ${ops}`);
					}
					this.log(`response fetchOps. operations:${ops.length}`);
					for (const op of ops) {
						const opType = cl.checkAndGetValue
							? cl.checkAndGetValue(op, "type", 3)
							: op.type;

						const param1 = cl.checkAndGetValue
							? cl.checkAndGetValue(op, "param1", 10)
							: op.param1;

						const param2 = cl.checkAndGetValue
							? cl.checkAndGetValue(op, "param2", 11)
							: op.param2;
						if (opType === 0) {
							if (param1 != null) {
								// split behavior as Python

								cl.individualRev = String(param1).split("\x1e")[0];
								this.log(`individualRev: ${cl.individualRev}`);
							}
							if (param2 != null) {
								cl.globalRev = String(param2).split("\x1e")[0];
								this.log(`globalRev: ${cl.globalRev}`);
							}
						}

						const rev = cl.checkAndGetValue
							? cl.checkAndGetValue(op, "revision", 1)
							: op.revision;

						cl.setRevision && cl.setRevision(rev);
						if (typeof this.hookCallback === "function") {
							this.hookCallback(cl, serviceType, op);
						}
					}
					// LOOP: request next fetch
					const fetch_req_data = { revision: cl.revision };
					await this.buildAndSendSignOnRequest(_conn, serviceType, fetch_req_data);
					return;
				} */ else {
					this.log("unknown:", parsed);
					return;
				}
			} else {
				throw new Error(`[PUSH] receives invalid sign-on-response frame. requestId:${reqId}, service:${serviceType}`);
			}
		} catch (error) {
			// Swallowing this silently leaves the bot looking online while
			// it has stopped receiving anything — the one failure mode a
			// bot that exists to answer first cannot afford to hide.
			this.log("SignOnResponseError", {
				requestId: reqId,
				serviceType: this.signOnRequests[reqId]?.[0],
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
	}

	/**
	 * Keeps a square fetch armed on the push connection.
	 *
	 * Without this, an OpenChat notification only says "something changed"
	 * and the events have to be fetched over a separate HTTP request — a
	 * full round trip to Japan before the bot even knows what was said.
	 * Re-arming makes the server deliver the events inline, the way the
	 * talk stream already works.
	 *
	 * Always re-arms, including after an empty answer — it just waits
	 * `idleDelayMs` first, which is what keeps a non-blocking server from
	 * being spun on unthrottled.
	 */
	async #rearmSquareFetch(subscriptionId: number, syncToken: string, eventCount: number): Promise<void> {
		if (!SQUARE_REARM_ENABLED) return;

		const decision = this.#squareRearm.next(eventCount);
		if (decision.delayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, decision.delayMs));
		}

		// Read the connection *after* the delay, not before it. Capturing it up
		// front meant the idle wait could straddle a reconnect and the re-arm
		// would then be written into a connection that had already been closed
		// and spliced out — the write throws, `_OnSignOnResponse`'s catch logs
		// it and returns, and because nothing but this chain re-arms the chain,
		// OpenChat goes silent until something else happens to rebuild the
		// connection. That is the silent half of the stall.
		const conn = this.conns[0];
		if (!conn) {
			// Always logged, never a `failure`: losing the race against a
			// reconnect is routine, and `InitAndRead` arms service 3 again on
			// the new connection. What was not routine was having no way to
			// see it happen — the stall watchdog in session-manager.ts reads
			// `lastSquareFetchAt`, which cannot distinguish "chain ended here"
			// from "room is quiet".
			this.log("SquareRearmSkipped", { reason: "no-connection", subscriptionId });
			return;
		}

		try {
			await this.buildAndSendSignOnRequest(conn, 3, {
				request: { subscriptionId, syncToken, limit: 100 },
			});
		} catch (error) {
			// Distinct from the generic SignOnResponseError this would otherwise
			// surface as: that name covers every branch of the response handler,
			// so a dead re-arm chain looked identical to a parse failure on some
			// unrelated service. Rethrown so the caller's handler still runs.
			this.log("SquareRearmError", {
				subscriptionId,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	async _OnPushResponse(pushFrame: LegyH2PushFrame) {
		this.log("_OnPushResponse", pushFrame);
		try {
			if (pushFrame.serviceType === 3 && pushFrame.pushPayload) {
				this.subscriptionId = this.client.thrift.readThriftStruct(pushFrame.pushPayload, TCompactProtocol)[1];
				// Queued behind any in-flight rearm-response processing — see
				// `#squareFetchQueue`. Reading `poll.sync.square` here
				// before a concurrent rearm fetch has written its own result
				// is exactly the race that dropped events under bursty
				// traffic; waiting the (typically low tens of ms) for that
				// fetch to settle first costs far less than losing a message.
				await this.#squareFetchQueue.run(async () => {
					const res = await this.client.square.fetchMyEvents({
						subscriptionId: this.subscriptionId,
						syncToken: this.client.poll.sync.square,
						limit: 100,
					});
					const { events, syncToken, subscription } = res;

					for (const ev of events) {
						this.sqStream.enqueue(ev);
					}
					if (this.client.poll.sync.square !== syncToken) {
						this.client.poll.sync.square = syncToken;
						this.client.emit("update:syncdata", this.client.poll.sync);
					}

					this.subscriptionId = Number(subscription.subscriptionId);
					this.lastSquareFetchAt = Date.now();

					this.log("SQ_fetchMyEvents", {
						syncToken,
						subscriptionId: this.subscriptionId,
					});
				});
			}
		} catch (error) {
			// Bound method called fire-and-forget from `conn.ts`'s synchronous
			// packet handler — nothing there awaits or catches this promise.
			// Left unguarded, a rejected `fetchMyEvents` (network blip, stale
			// subscription, auth hiccup) becomes an unhandled rejection with no
			// `[bot N]` tag and no reaction, unlike every sibling failure path
			// in this class (`_OnSignOnResponse`'s `SignOnResponseError`,
			// `_OnPingCallback`'s `LegyPusherError` — the latter is exactly the
			// bug that once took the whole backend process down, per the
			// comment there).
			this.log("PushResponseError", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	_OnPingCallback(pingId: number) {
		this.currPingId = pingId;
		const t1 = Date.now() / 1000;
		const refreshIds: number[] = [];
		for (const k of Object.keys(this.subscriptionIds)) {
			const id = Number(k);
			const t2 = this.subscriptionIds[id];
			if (t1 - t2 >= 3000) {
				this.subscriptionIds[id] = Date.now() / 1000;
				refreshIds.push(id);
			}
		}
		if (refreshIds.length) {
			this.log(`?refresh square subscriptionId: ${refreshIds}`);
		}
		if (pingId % 3 === 0) {
			// This probe MUST stay caught. LINE answers it with
			// NOT_AUTHORIZED_DEVICE the moment the account is logged out
			// elsewhere, and as a floating promise that rejection took down the
			// entire backend process — every other bot with it. Reported as a
			// push failure instead, which the session watchdog already reacts to
			// by reconnecting (or falling back to a fresh QR).
			this.client.talk
				.noop()
				.then(() => {
					const oldToken = this.authToken;
					const newToken = this.client.authToken;
					if (oldToken !== newToken && newToken) {
						this.log("renew push conn for new authToken...");
						this.authToken = newToken;
						this.conns[0].close();
					}
				})
				.catch((err: LooseType) => {
					this.log("LegyPusherError", {
						at: "keepalive noop",
						error: err instanceof Error ? err.message : String(err),
					});
				});
		}
	}

	/**
	 * Arms one square fetch on the existing connection, restarting a re-arm
	 * chain that has stopped perpetuating itself.
	 *
	 * The chain is normally self-sustaining: every `fetchMyEvents` response
	 * arms the next request. Nothing else keeps it going, so any single break
	 * — a write that lost the race against a reconnect, a response that never
	 * arrived — ends OpenChat delivery for good, while the connection, the
	 * credential, and the talk stream all stay healthy and make the session
	 * look fine from every other angle.
	 *
	 * This is the cheapest possible repair for that: the same request
	 * `InitAndRead` issues on connect, with no teardown, no re-login, and no
	 * visible status change. Callers escalate to closing the connection only
	 * when this does not take.
	 */
	async rearmSquareNow(): Promise<boolean> {
		const conn = this.conns[0];
		if (!conn) return false;
		// Reuse the live subscription when there is one; a fresh id is only
		// needed when we have never successfully subscribed on this connection.
		const subscriptionId = this.subscriptionId || Math.floor(Date.now());
		await this.buildAndSendSignOnRequest(conn, 3, {
			request: {
				subscriptionId,
				syncToken: this.client.poll.sync.square,
				limit: 100,
			},
		});
		this.log("SquareRearmForced", { subscriptionId });
		return true;
	}

	async InitAndRead(initServices: number[] = [3, 5]) {
		if (!this.conns || this.conns.length === 0) {
			throw new Error("No valid connections found.");
		}
		const _conn = this.conns[0];

		const FLAG = 0;
		const statusPayload = new Uint8Array([0, FLAG, this._pingInterval]);
		await _conn.writeRequest(0, statusPayload);
		this.log(`send status frame. flag:${FLAG}, pi:${this._pingInterval}`);

		for (const service of initServices) {
			this.log(`Init service: ${service}`);
			if (service === 3) {
				const subscriptionId = Math.floor(Date.now());
				const syncToken = this.client.poll.sync.square;
				const ex_val: PartialDeep<SquareService_fetchMyEvents_args> = {
					request: {
						subscriptionId,
						syncToken,
						limit: 100,
					},
				};
				this.log(`request fetchMyEvent(${subscriptionId}), syncToken:${syncToken}`);
				// clear tracked subscriptions
				this.subscriptionIds = {};
				await this.buildAndSendSignOnRequest(_conn, service, ex_val);
			} else if ([5, 8].includes(service)) {
				const ex_val: PartialDeep<sync_args> = {
					request: {
						lastRevision: this.client.poll.sync.talk.revision,
						count: 100,
						lastGlobalRevision: this.client.poll.sync.talk.globalRev,
						lastIndividualRevision: this.client.poll.sync.talk.individualRev,
					},
				};
				if (this.client.debugLogsEnabled) {
					this.log(`request talk fetcher: ${JSON.stringify(ex_val)}`);
				}
				await this.buildAndSendSignOnRequest(_conn, service, ex_val);
			} else {
				// await this.buildAndSendSignOnRequest(_conn, service, {});
			}
		}

		this.log("CONN start read push.");
		const readResult = await _conn.read();
		this.log(`CONN died on PingId=${this.currPingId}`, readResult);
		const idx = this.conns.indexOf(_conn);
		if (idx >= 0) this.conns.splice(idx, 1);
	}
}
