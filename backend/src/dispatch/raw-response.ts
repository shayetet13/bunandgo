const RAW_DISPATCH_BODY = Symbol.for("linebot.rawDispatchBody");

type DispatchResponse = Response & { [RAW_DISPATCH_BODY]?: Uint8Array };

export function attachRawDispatchBody(response: Response, body: Uint8Array): Response {
	Object.defineProperty(response, RAW_DISPATCH_BODY, { value: body });
	return response;
}

export function readResponseBytes(response: Response): Uint8Array | Promise<Uint8Array> {
	const raw = (response as DispatchResponse)[RAW_DISPATCH_BODY];
	// Owned dispatch transports already buffered the body. Returning it
	// synchronously avoids a Promise/microtask hop on every latency-sensitive
	// ACK while preserving the normal fetch fallback for ordinary responses.
	return raw ?? response.arrayBuffer().then((body) => new Uint8Array(body));
}
