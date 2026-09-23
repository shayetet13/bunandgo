import { type NestedArray, type ParsedThrift, type ProtocolKey, Protocols } from "../thrift/mod.ts";
import { type BaseClient, InternalError } from "../core/mod.ts";
import { shouldUseLegyEncryptedAccess } from "./auth_token.ts";
import { LegyEncryptedTransport } from "./legy.ts";
import { readResponseBytes } from "../../../dispatch/raw-response.ts";
import { H2_LANE_ROLE_HEADER } from "../../../dispatch/h2-lanes.ts";
import { markProtocolPrep } from "../../../metrics/fast-path.ts";

const square = ["/SQ1", "/SQLV1"];
const SENSITIVE_HEADERS = /^(?:authorization|cookie|set-cookie|x-line-access|x-line-next-access|x-line-.*token)$/i;
const ERROR_BODY_PREVIEW_BYTES = 256;

export function safeResponseHeaders(headers: Headers): Array<[string, string]> {
	return [...headers.entries()].map(([name, value]) => [name, SENSITIVE_HEADERS.test(name) ? "[REDACTED]" : value]);
}

/**
 * Same redaction as safeResponseHeaders, for the outgoing side — used
 * wherever a debug log would otherwise include the live `x-line-access`
 * bearer token in plaintext (see the two `debugLogsEnabled` request-log
 * call sites in this file and the matching one in service/talk/mod.ts).
 */
export function safeRequestHeaders(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, SENSITIVE_HEADERS.test(name) ? "[REDACTED]" : value]));
}

function hexBodyPreview(body: Uint8Array): string {
	const preview = body.subarray(0, ERROR_BODY_PREVIEW_BYTES);
	const hex = [...preview].map((value) => value.toString(16)).join(" ");
	return body.byteLength > preview.byteLength ? `${hex} … (${body.byteLength} bytes total)` : hex;
}

/**
 * Request Client
 */
/**
 * @class RequestClient
 * @description A client for making requests to the LINE API.
 *
 * @property {BaseClient} client - The base client instance.
 * @property {string} endpoint - The endpoint for the API requests.
 * @property {string} userAgent - The user agent string for the requests.
 * @property {string} systemType - The system type string for the requests.
 * @property {Record<string, string | undefined>} EXCEPTION_TYPES - A static record of exception types based on request paths.
 *
 * @constructor
 * @param {BaseClient} client - The base client instance.
 */
export class RequestClient {
	readonly client: BaseClient;
	endpoint: string;
	userAgent: string;
	#legyTransport?: LegyEncryptedTransport;
	/**
	 * x-line-application
	 */
	systemType: string;
	static readonly EXCEPTION_TYPES: Record<string, string | undefined> = {
		"/S3": "TalkException",
		"/S4": "TalkException",
		"/SYNC4": "TalkException",
		"/SYNC3": "TalkException",
		"/CH3": "ChannelException",
		"/CH4": "ChannelException",
		"/SQ1": "SquareException",
		"/LIFF1": "LiffException",
		"/api/v3p/rs": "TalkException",
		"/api/v4p/rs": "TalkException",
		"/api/v3/TalkService.do": "TalkException",
	};

	constructor(client: BaseClient) {
		const deviceDetails = client.deviceDetails;
		this.endpoint = client.endpoint ?? "legy.line-apps.com";
		this.systemType = `${deviceDetails.device}\t${deviceDetails.appVersion}\t${deviceDetails.systemName}\t${deviceDetails.systemVersion}`;
		this.userAgent = `Line/${deviceDetails.appVersion}`;
		this.client = client;
	}

	/**
	 * @description Request to LINE API.
	 *
	 * @param value - The thrift value(argument) to request.
	 * @param methodName - The method name of the request.
	 * @param protocolType - The protocol type of the request.
	 * @param parse - Whether to parse the response.
	 * @param path - The path of the request.
	 * @param headers - The headers of the request.
	 * @param timeout - The timeout milliseconds of the request.
	 * @returns The response.
	 */
	public async request<T = unknown>(
		value: NestedArray,
		methodName: string,
		protocolType: ProtocolKey = 3,
		parse: boolean | string = true,
		path: string = "/S3",
		headers: Record<string, string | undefined> = {},
		timeout = this.client.config.timeout,
		signal?: AbortSignal,
	): Promise<T> {
		if (this.client?.disabled) {
			throw new InternalError("ClientClosed", "Request aborted: client has been disabled (logged out)");
		}
		const res = await this.requestCore(path, value, methodName, protocolType, headers, undefined, parse, undefined, timeout, signal);
		return res.data.success;
	}

	/**
	 * @description Request to LINE API by raw.
	 *
	 * @param {string} [path] - The path of the request.
	 * @param {NestedArray} [value] - The value to request.
	 * @param {string} [methodName] - The method name of the request.
	 * @param {ProtocolKey} [protocolType] - The protocol type of the request.
	 * @param {object} [appendHeaders={}] - The headers to append to the request.
	 * @param {string} [overrideMethod="POST"] - The method of the request.
	 * @param {boolean | string} [parse=true] - Whether to parse the response.
	 * @param {boolean} [isReRequest=false] - Is Re-Request.
	 * @param {number} [timeout=this.timeOutMs] - The timeout milliseconds of the request.
	 * @returns {Promise<ParsedThrift>} The response.
	 * @throws {InternalError} If the request fails or timeout.
	 */
	private async requestCore(
		path: string,
		value: NestedArray,
		methodName: string,
		protocolType: ProtocolKey,
		appendHeaders: object = {},
		overrideMethod: string = "POST",
		parse: boolean | string = true,
		isReRequest: boolean = false,
		timeout: number = this.client.config.timeout,
		signal?: AbortSignal,
	): Promise<ParsedThrift> {
		const protocolStartedAt = performance.now();
		const protocol = Protocols[protocolType];

		const headers: Record<string, string> = {
			...this.getHeader(overrideMethod),
			...appendHeaders,
		};

		if (this.client.debugLogsEnabled) {
			this.client.log("writeThrift", {
				value,
				methodName,
				protocolType,
			});
		}

		const Trequest = this.client.thrift.writeThrift(value, methodName, protocol);

		if (this.client.debugLogsEnabled) {
			this.client.log("request", {
				methodName,
				path: `https://${this.endpoint}${path}`,
				method: overrideMethod,
				headers: safeRequestHeaders(headers),
				timeout,
				body: Trequest as BodyInit,
			});
		}

		const url = `https://${this.endpoint}${path}`;
		// `fetchMyEvents` is what the push connection calls to actually retrieve
		// an event after a push frame (or the re-arm long-poll) notifies that one
		// exists — every bit as latency-sensitive as the per-room poll below, and
		// until now the one Square RPC left on the generic transport instead of
		// this process's own pre-warmed, IP-ranked lane pool. Confirmed live: push
		// won 0 of 86 real replies over 6h while dedicated-poll (already hot) won
		// the rest.
		const hotSquareRpc =
			path === "/SQ1" && (methodName === "sendMessage" || methodName === "fetchSquareChatEvents" || methodName === "fetchMyEvents");
		if (hotSquareRpc) {
			const isSend = methodName === "sendMessage";
			headers[H2_LANE_ROLE_HEADER] = isSend ? "send" : "poll";
			// RFC 9218 Extensible Priorities: u=0 is the most urgent a client can
			// ask for, u=7 the least. A server that does not implement the header
			// is required by the RFC to ignore it, so this cannot make a reply
			// slower even if LEGY does not act on it. Poll traffic is marked
			// incremental ("i") — later chunks of the same resource, not a
			// standalone deadline the way a reply is.
			headers.priority = isSend ? "u=0" : "u=7, i";
		}
		const init: RequestInit = {
			method: overrideMethod,
			headers,
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
			body: Trequest as BodyInit,
		};
		const useLegy = this.shouldUseLegyEncryptedRequest(path, headers);
		markProtocolPrep(performance.now() - protocolStartedAt);
		// Square replies and per-room event fetches are latency-sensitive even
		// when the caller asks for the complete Thrift result. `ACK_ONLY` controls
		// response parsing; it must not also decide whether `/SQ1` gets the owned,
		// pre-warmed HTTP/2 lane. Keeping these concerns separate lets the bot race
		// on the hot transport while retaining full send/visibility diagnostics.
		const response = useLegy
			? await this.legyTransport.fetch(new Request(url, init), this.client.fetch, {
					application: this.systemType,
					userAgent: this.userAgent,
					endpoint: this.client.legy.endpoint,
				})
			: parse === "ACK_ONLY" || hotSquareRpc
				? await this.client.fetchHot(url, init)
				: await this.client.fetch(url, init);
		const nextToken = response.headers.get("x-line-next-access");
		if (nextToken) {
			this.client.emit("update:authtoken", nextToken);
		}
		const responseBody = readResponseBytes(response);
		const parsedBody = responseBody instanceof Uint8Array ? responseBody : await responseBody;
		if (this.client.debugLogsEnabled) {
			this.client.log("response", {
				status: response.status,
				statusText: response.statusText,
				headers: safeResponseHeaders(response.headers),
				bodyBytes: parsedBody.byteLength,
				methodName,
			});
		}
		// Send hot paths do not consume the success object. Validate the result
		// envelope and skip its payload; if it is not a clean success, fall
		// through to the full parser so LINE errors retain complete details.
		if (parse === "ACK_ONLY" && response.ok && this.client.thrift.isSuccessfulResponse(parsedBody, protocol)) {
			return { data: { success: undefined }, _info: {} } as ParsedThrift;
		}
		if (parse === "ACK_ONLY") parse = false;

		let res: ParsedThrift;
		let hasError = false;
		try {
			res = this.client.thrift.readThrift(parsedBody, protocol);
		} catch {
			throw new Error(
				`Request internal failed: status=${response.status} ` +
					`headers=${JSON.stringify(safeResponseHeaders(response.headers))} ` +
					`body=<${hexBodyPreview(parsedBody)}>`,
			);
		}
		if (!res.data[0] && Object.keys(res.data).length) {
			hasError = true;
		}
		if (parse === true) {
			this.client.thrift.rename_data(res, square.includes(path));
		} else if (typeof parse === "string") {
			res.data.success = this.client.thrift.rename_thrift(parse, res.data[0]);
			delete res.data[0];
			if (res.data[1]) {
				const structName = RequestClient.EXCEPTION_TYPES[path] || "TalkException";
				if (structName) {
					res.data.e = this.client.thrift.rename_thrift(structName, res.data[1]);
				} else {
					res.data.e = res.data[1];
				}
				delete res.data[1];
			}
		} else {
			res.data.success = res.data[0];
			delete res.data[0];
			if (res.data[1]) {
				const structName = RequestClient.EXCEPTION_TYPES[path] || "TalkException";
				if (structName) {
					res.data.e = this.client.thrift.rename_thrift(structName, res.data[1]);
				} else {
					res.data.e = res.data[1];
				}
				delete res.data[1];
			}
		}

		if (this.client.debugLogsEnabled) {
			this.client.log("readThrift", {
				res,
			});
		}

		const isRefresh = Boolean(res.data.e && res.data.e.code === "MUST_REFRESH_V3_TOKEN" && (await this.client.storage.get("refreshToken")));

		if (res.data.e && !isRefresh) {
			throw new InternalError(
				"RequestError",
				`Request internal failed, ${methodName}(${path}) -> ` + JSON.stringify(res.data.e),
				res.data.e,
			);
		}
		if (hasError && !isRefresh) {
			if (res.data.e?.code === "NOT_AUTHORIZED_DEVICE") {
				delete this.client.authToken;
				this.client.emit("end", this.client.profile!);
			}
			throw new InternalError("RequestError", `Request internal failed, ${methodName}(${path}) -> ` + JSON.stringify(res.data), res.data);
		}

		if (isRefresh && !isReRequest) {
			await this.client.auth.tryRefreshToken();
			return this.requestCore(path, value, methodName, protocolType, appendHeaders, overrideMethod, parse, true, timeout, signal);
		}
		return res;
	}

	/**
	 * Get HTTP headers for a request.
	 * @param {string} [overrideMethod="POST"] The HTTP method to use in the `x-lhm` header.
	 * @returns {Record<string, string>} An object with the headers as key-value pairs.
	 */
	public getHeader(overrideMethod: string = "POST"): Record<string, string> {
		const header = {
			Host: this.endpoint,
			accept: "application/x-thrift",
			"user-agent": this.userAgent,
			"x-line-application": this.systemType,
			"content-type": "application/x-thrift",
			"x-lal": "ja_JP",
			"x-lpv": "1",
			"x-lhm": overrideMethod,
			"accept-encoding": "gzip",
		} as Record<string, string>;

		if (this.client.authToken) {
			header["x-line-access"] = this.client.authToken;
		}

		return header;
	}

	private get legyTransport(): LegyEncryptedTransport {
		return (this.#legyTransport ??= new LegyEncryptedTransport(this.client.legy.endpoint));
	}

	private shouldUseLegyEncryptedRequest(path: string, headers: Record<string, string>): boolean {
		const mode = this.client.legy.encrypted;
		if (mode === false) return false;
		if (!headers["x-line-access"]) return false;
		if (mode === true) return true;
		return isLegyTalkPath(path) && shouldUseLegyEncryptedAccess(headers["x-line-access"]);
	}
}

function isLegyTalkPath(path: string): boolean {
	return (
		path === "/S3" ||
		path === "/S4" ||
		path === "/V4" ||
		path === "/SYNC3" ||
		path === "/SYNC4" ||
		path === "/P4" ||
		path === "/P5" ||
		path === "/NP4" ||
		path === "/NP5" ||
		path === "/C5" ||
		path === "/CA5" ||
		path === "/ECA5"
	);
}
