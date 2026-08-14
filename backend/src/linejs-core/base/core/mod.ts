import {
	type Device,
	type DeviceDetails,
	getDeviceDetails,
} from "./utils/devices.ts";

import { type BaseStorage, MemoryStorage } from "../storage/mod.ts";

import { TypedEventEmitter } from "./typed-event-emitter/index.ts";

import type { ClientEvents, Log } from "./utils/events.ts";
import { InternalError } from "./utils/error.ts";
import { type Continuable, continueRequest } from "./utils/continue.ts";

export type { Continuable, Device, DeviceDetails, Log };
export { continueRequest, InternalError };

import {
	AuthService,
	CallService,
	ChannelService,
	LiffService,
	RelationService,
	SquareLiveTalkService,
	SquareService,
	TalkService,
} from "../service/mod.ts";

import { Login } from "../login/mod.ts";
import { Thrift } from "../thrift/mod.ts";
import { RequestClient } from "../request/mod.ts";
import type { AuthTokenInput } from "../request/auth_token.ts";
import { E2EE } from "../e2ee/mod.ts";
import { LineObs } from "../obs/mod.ts";
import { Timeline } from "../timeline/mod.ts";
import {
	getHotLineFetch,
	getHotLinePrewarmFetch,
	type HotLineFetch,
} from "../../../dispatch/direct-request.ts";
import { attachRawDispatchBody } from "../../../dispatch/raw-response.ts";
import {
	PREWARM_SQUARE_ACK,
	PREWARM_TALK_ACK,
} from "../../../dispatch/prewarm-ack.ts";
import {
	currentPrewarmScope,
	runInPrewarmScope,
} from "../../../dispatch/prewarm-scope.ts";
import { Polling } from "../polling/mod.ts";
import { ConnManager } from "../push/mod.ts";

import { Thrift as def } from "@evex/linejs-types/thrift";

import type * as LINETypes from "@evex/linejs-types";
import type { Fetch, FetchLike } from "../types.ts";
import type { LooseType } from "@evex/loose-types";

export interface LoginOption {
	email?: string;
	password?: string;
	pincode?: string;
	authToken?: AuthTokenInput;
	qr?: boolean;
	e2ee?: boolean;
	v3?: boolean;
}

export interface ClientInit {
	/**
	 * version which LINE App to emulating
	 */
	version?: string;

	/**
	 * API Endpoint
	 * @default "legy.line-apps.com"
	 */
	endpoint?: string;

	/**
	 * Device
	 */
	device: Device;

	/**
	 * Storage
	 * @default MemoryStorage
	 */
	storage?: BaseStorage;

	/**
	 * Custom function to connect network.
	 * @default `globalThis.fetch`
	 */
	fetch?: FetchLike;

	/**
	 * LEGY encrypted gateway options.
	 *
	 * `auto` encrypts requests for modern JWT/primary/auth-key tokens while
	 * keeping legacy opaque auth tokens on the normal endpoint.
	 *
	 * @default { encrypted: "auto" }
	 */
	legy?: {
		encrypted?: boolean | "auto";
		endpoint?: string;
	};
}

export interface Config {
	/**
	 * Timeout
	 * @default 30_000
	 */
	timeout: number;

	/**
	 * Long timeout
	 * @default 180_000
	 */
	longTimeout: number;
}

/**
 * LINE.js client, which is entry point.
 */
export class BaseClient extends TypedEventEmitter<ClientEvents> {
	authToken?: string;
	readonly device: Device;
	readonly loginProcess: Login;
	readonly thrift: Thrift;
	readonly request: RequestClient;
	readonly storage: BaseStorage;
	readonly e2ee: E2EE;
	readonly obs: LineObs;
	readonly timeline: Timeline;
	readonly poll: Polling;
	readonly push: ConnManager;

	readonly auth: AuthService;
	readonly call: CallService;
	readonly channel: ChannelService;
	readonly liff: LiffService;
	readonly relation: RelationService;
	readonly livetalk: SquareLiveTalkService;
	readonly square: SquareService;
	readonly talk: TalkService;
	#customFetch?: FetchLike;
	#hotFetch?: HotLineFetch;
	#hotPrewarmFetch?: HotLineFetch;
	readonly debugLogsEnabled =
		globalThis.process?.env?.LINEJS_DEBUG_LOGS === "1";
	disabled?: boolean;
	profile?: LINETypes.Profile;
	config: Config;
	readonly deviceDetails: DeviceDetails;
	readonly endpoint: string;
	readonly legy: {
		encrypted: boolean | "auto";
		endpoint?: string;
	};
	/**
	 * Initializes a new instance of the class.
	 *
	 * @param init - The initialization parameters.
	 * @param init.device - The device type.
	 * @param init.version - The version of the device.
	 * @param init.fetch - Optional custom fetch function.
	 * @param init.endpoint - Optional endpoint URL.
	 * @param init.storage - Optional storage mechanism.
	 *
	 * @throws {Error} If the device is unsupported.
	 *
	 * @example
	 * ```typescript
	 * const client = new Client({
	 *   device: 'iOS',
	 *   version: '10.0',
	 *   fetch: customFetchFunction,
	 *   endpoint: 'custom-endpoint.com',
	 *   storage: new FileStorage("./storage.json"),
	 * });
	 * ```
	 */
	constructor(init: ClientInit) {
		super();
		const deviceDetails = getDeviceDetails(init.device, init.version);
		if (!deviceDetails) {
			throw new Error(`Unsupported device: ${init.device}.`);
		}
		if (init.fetch) {
			this.#customFetch = init.fetch;
			this.#hotFetch = getHotLineFetch(init.fetch);
			this.#hotPrewarmFetch = getHotLinePrewarmFetch(init.fetch);
		}
		this.deviceDetails = deviceDetails;
		this.endpoint = init.endpoint ?? "legy.line-apps.com";
		this.config = {
			timeout: 30_000,
			longTimeout: 180_000,
		};
		this.device = init.device;
		this.legy = {
			encrypted: init.legy?.encrypted ?? "auto",
			endpoint: init.legy?.endpoint,
		};

		this.storage = init.storage ?? new MemoryStorage();
		this.request = new RequestClient(this);
		this.loginProcess = new Login(this);
		this.thrift = new Thrift();
		this.thrift.def = def;
		this.e2ee = new E2EE(this);
		this.obs = new LineObs(this);
		this.timeline = new Timeline(this);
		this.poll = new Polling(this);
		this.push = new ConnManager(this);

		this.auth = new AuthService(this);
		this.call = new CallService(this);
		this.channel = new ChannelService(this);
		this.liff = new LiffService(this);
		this.livetalk = new SquareLiveTalkService(this);
		this.relation = new RelationService(this);
		this.square = new SquareService(this);
		this.talk = new TalkService(this);
	}

	log(type: string, data: Record<string, LooseType>) {
		// Verbose protocol logging allocates and synchronously fans out on the
		// same event loop that must answer the message. Production keeps only
		// failures. Full protocol and Square fetch diagnostics remain available
		// behind their opt-in environment switches. Logging one line per empty
		// long-poll competes with replies through stdout/journald over time.
		const squareDiagnosticsEnabled =
			globalThis.process?.env?.LINEJS_SQUARE_DIAGNOSTICS === "1";
		if (
			globalThis.process?.env?.LINEJS_DEBUG_LOGS !== "1" &&
			!type.startsWith("SignOnResponseError") &&
			!(squareDiagnosticsEnabled && type.startsWith("[SQ_DIAG]")) &&
			type !== "LegyPusherError" &&
			type !== "LegyPusherError_cannot_init" &&
			type !== "TalkMessageError" &&
			type !== "ListenerStopped"
		) {
			return;
		}
		this.emit("log", { type, data });
	}
	getToType(mid: string): number | null {
		switch (mid[0]) {
			case "u":
				return 0;
			case "r":
				return 1;
			case "c":
				return 2;
			case "s":
				return 3;
			case "m":
				return 4;
			case "p":
				return 5;
			case "v":
				return 6;
			case "t":
				return 7;
			default:
				return null;
		}
	}
	reqseqs?: Record<string, number>;
	#reqseqPersistQueued = false;
	/**
	 * Hands out the next request sequence number for `name`.
	 *
	 * The counter lives in memory and is persisted write-behind: the
	 * storage write is fire-and-forget rather than awaited, because every
	 * outbound message blocks on this call and awaiting the write added a
	 * measured ~1.1ms to each send for a value that is only ever read once,
	 * at startup. A write lost to a crash costs at most a replayed seq,
	 * which LINE tolerates; a slow send costs the race.
	 */
	async getReqseq(name: string = "talk"): Promise<number> {
		if (!this.reqseqs) {
			this.reqseqs = JSON.parse(
				((await this.storage.get("reqseq")) ?? "{}").toString(),
			) as Record<string, number>;
		}
		return this.takeReqseq(name)!;
	}

	/** Returns immediately after preload; undefined means the cold async read is still required. */
	takeReqseq(name: string = "talk"): number | undefined {
		// Dry startup sends must exercise the exact encoder without consuming
		// a real LINE sequence number or scheduling persistence work.
		const prewarm = currentPrewarmScope();
		if (prewarm) {
			const seq = prewarm.reqseqs[name] ?? 0;
			prewarm.reqseqs[name] = seq + 1;
			return seq;
		}
		if (!this.reqseqs) return undefined;
		if (!this.reqseqs[name]) {
			this.reqseqs[name] = 0;
		}
		const seq = this.reqseqs[name];
		this.reqseqs[name]++;
		// Persist while the LINE request is in flight. Coalescing also avoids
		// JSON/string allocation in front of every hot-path fetch call.
		if (!this.#reqseqPersistQueued) {
			this.#reqseqPersistQueued = true;
			queueMicrotask(() => {
				this.#reqseqPersistQueued = false;
				void Promise.resolve(
					this.storage.set("reqseq", JSON.stringify(this.reqseqs)),
				).catch(() => {});
			});
		}
		return seq;
	}

	/** Loads the persisted reqseq counters so the first send never waits on disk. */
	async preloadReqseq(): Promise<void> {
		await this.getReqseq("__preload");
	}

	// NOTE: use allow function.
	// `const { fetch } = base` is not working if you change to function decorations.
	readonly fetch: Fetch = async (
		info: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		// Most protocol callers already hand us a complete Request. Cloning it
		// here copied headers/body again on every outbound message.
		const req = info instanceof Request && init === undefined
			? info
			: new Request(info, init);
		const res =
			await (this.#customFetch
				? this.#customFetch(req)
				: globalThis.fetch(req));
		return res;
	};

	/** Invokes the latency-first transport before allocating a wrapper Request. */
	readonly fetchHot: Fetch = (
		info: RequestInfo | URL,
		init?: RequestInit,
	): Promise<Response> => {
		// Resolve the production symbol during dry runs too, so its first
		// lookup is never charged to the first real message.
		const hotFetch = this.#hotFetch;
		if (currentPrewarmScope()) {
			const prewarmFetch = this.#hotPrewarmFetch;
			if (prewarmFetch) return prewarmFetch(info, init);
			const body = String(info).includes("/SQ1")
				? PREWARM_SQUARE_ACK
				: PREWARM_TALK_ACK;
			return Promise.resolve(
				attachRawDispatchBody(new Response(body as BodyInit), body),
			);
		}
		return hotFetch ? hotFetch(info, init) : this.fetch(info, init);
	};

	/**
	 * Runs the exact outbound call stack against an in-RAM ACK.
	 *
	 * Scoped to this call tree, not to a window of time: real traffic already
	 * in flight on the same client keeps going to LINE untouched.
	 */
	async prewarmHotRequests(fn: () => Promise<unknown>): Promise<void> {
		await runInPrewarmScope(fn);
	}

	/**
	 * returns polling client.
	 */
	createPolling(): Polling {
		return this.poll;
	}

	/**
	 * JSON replacer to remove mid and authToken, parse bigint to number
	 *
	 * ```
	 * JSON.stringify(data, BaseClient.jsonReplacer);
	 * ```
	 */
	static jsonReplacer(k: LooseType, v: LooseType): LooseType {
		if (typeof v === "bigint") {
			//@ts-expect-error https://developer.mozilla.org/ja/docs/Web/JavaScript/Reference/Global_Objects/JSON/rawJSON
			return JSON.rawJSON(v.toString());
		}
		if (typeof v === "string") {
			const midType = v.match(/([ucrpmst])[0123456789abcdef]{32}/);
			if (midType && midType[1]) {
				return `[${midType[1].toUpperCase()} mid]`;
			}
			if (k === "x-line-access" || k === "x-lt" || k === "x-lcs") {
				return `[AuthToken]`;
			}
		}
		if (typeof v === "object") {
			if (Array.isArray(v)) {
				return v.map((item) => BaseClient.jsonReplacer("", item));
			}
			if (v instanceof Uint8Array) {
				return `Uint8Array[${v.length}]<${
					Array.from(v)
						.map((e) => e.toString(16).padStart(2, "0"))
						.join(" ")
				}>`;
			}
			if (v.type === "Buffer" && Array.isArray(v.data)) {
				return `Buffer[${v.data.length}]<${
					Array.from(v.data)
						.map((e) => Number(e).toString(16).padStart(2, "0"))
						.join(" ")
				}>`;
			}
			if (v instanceof Blob) {
				return `Blob[${v.size}]@${v.type}`;
			}

			const newObj: LooseType = {};
			let midCount = 0;
			for (const key in v) {
				if (Object.prototype.hasOwnProperty.call(v, key)) {
					const value = v[key];
					const midType = key.match(/(.)[0123456789abcdef]{32}/);
					if (midType && midType[1]) {
						midCount++;
						newObj[`[${midType[1].toUpperCase()} mid ${midCount}]`] = value;
					} else {
						newObj[key] = value;
					}
				}
			}
			return newObj;
		}
		return v;
	}
}
