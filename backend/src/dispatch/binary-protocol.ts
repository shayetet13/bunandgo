const REQUEST_MAGIC = new Uint8Array([0x4c, 0x44, 0x42, 0x31]); // LDB1
const RESPONSE_MAGIC = new Uint8Array([0x4c, 0x44, 0x52, 0x31]); // LDR1
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface BinaryDispatchRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: Uint8Array;
}

export interface BinaryDispatchResponse {
	status: number;
	headers: Record<string, string[]>;
	body: Uint8Array;
	upstreamMs: number;
	goPrepMs: number;
}

function encoded(value: string): Uint8Array {
	return encoder.encode(value);
}

export function encodeDispatchRequest(request: BinaryDispatchRequest): Uint8Array {
	const method = encoded(request.method);
	const url = encoded(request.url);
	const headers = Object.entries(request.headers).map(([key, value]) => [
		encoded(key),
		encoded(value),
	] as const);
	let size = 4 + 2 + method.length + 4 + url.length + 2 + 4 + request.body.length;
	for (const [key, value] of headers) size += 2 + key.length + 4 + value.length;

	const out = new Uint8Array(size);
	const view = new DataView(out.buffer);
	let offset = 0;
	const bytes = (value: Uint8Array): void => {
		out.set(value, offset);
		offset += value.length;
	};
	const u16 = (value: number): void => {
		view.setUint16(offset, value, false);
		offset += 2;
	};
	const u32 = (value: number): void => {
		view.setUint32(offset, value, false);
		offset += 4;
	};

	bytes(REQUEST_MAGIC);
	u16(method.length);
	bytes(method);
	u32(url.length);
	bytes(url);
	u16(headers.length);
	for (const [key, value] of headers) {
		u16(key.length);
		bytes(key);
		u32(value.length);
		bytes(value);
	}
	u32(request.body.length);
	bytes(request.body);
	return out;
}

export function decodeDispatchResponse(data: Uint8Array): BinaryDispatchResponse {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let offset = 0;
	const need = (length: number): void => {
		if (offset + length > data.length) throw new Error("truncated binary dispatch response");
	};
	const bytes = (length: number): Uint8Array => {
		need(length);
		const value = data.subarray(offset, offset + length);
		offset += length;
		return value;
	};
	const u16 = (): number => {
		need(2);
		const value = view.getUint16(offset, false);
		offset += 2;
		return value;
	};
	const u32 = (): number => {
		need(4);
		const value = view.getUint32(offset, false);
		offset += 4;
		return value;
	};
	const u64 = (): bigint => {
		need(8);
		const value = view.getBigUint64(offset, false);
		offset += 8;
		return value;
	};
	const string = (length: number): string => decoder.decode(bytes(length));

	const magic = bytes(4);
	if (!magic.every((value, index) => value === RESPONSE_MAGIC[index])) {
		throw new Error("invalid binary dispatch response magic");
	}
	const status = u16();
	const upstreamMs = Number(u64()) / 1_000_000;
	const goPrepMs = Number(u64()) / 1_000_000;
	const headerCount = u16();
	const headers: Record<string, string[]> = {};
	for (let i = 0; i < headerCount; i++) {
		const key = string(u16());
		const valueCount = u16();
		const values: string[] = [];
		for (let j = 0; j < valueCount; j++) values.push(string(u32()));
		headers[key] = values;
	}
	const body = bytes(u32());
	if (offset !== data.length) throw new Error("trailing binary dispatch response data");
	// `body` is already a view over an owned response buffer. Returning the
	// view avoids one full response copy before linejs parses it.
	return { status, headers, body, upstreamMs, goPrepMs };
}
