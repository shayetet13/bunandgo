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

const MAX_FRAME_BYTES = 16 << 20;

function frameReader(data: Uint8Array) {
	if (data.byteLength > MAX_FRAME_BYTES) throw new Error("binary dispatch frame too large");
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let offset = 0;
	const need = (length: number): void => {
		if (offset + length > data.length) throw new Error("truncated binary dispatch frame");
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
	const done = (): void => {
		if (offset !== data.length) throw new Error("trailing binary dispatch frame data");
	};
	return { bytes, u16, u32, u64, string, done };
}

function assertMagic(actual: Uint8Array, expected: Uint8Array, label: string): void {
	if (!actual.every((value, index) => value === expected[index])) {
		throw new Error(`invalid binary dispatch ${label} magic`);
	}
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

export function decodeDispatchRequest(data: Uint8Array): BinaryDispatchRequest {
	const reader = frameReader(data);
	assertMagic(reader.bytes(4), REQUEST_MAGIC, "request");
	const method = reader.string(reader.u16());
	const url = reader.string(reader.u32());
	const headerCount = reader.u16();
	const headers: Record<string, string> = {};
	for (let index = 0; index < headerCount; index++) {
		const key = reader.string(reader.u16());
		headers[key] = reader.string(reader.u32());
	}
	const body = reader.bytes(reader.u32());
	reader.done();
	return { method, url, headers, body };
}

export function encodeDispatchResponse(response: BinaryDispatchResponse): Uint8Array {
	const headers = Object.entries(response.headers).map(([key, values]) => [
		encoded(key.toLowerCase()),
		values.map(encoded),
	] as const);
	let size = 4 + 2 + 8 + 8 + 2 + 4 + response.body.length;
	for (const [key, values] of headers) {
		size += 2 + key.length + 2;
		for (const value of values) size += 4 + value.length;
	}
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
	const u64 = (value: number): void => {
		view.setBigUint64(offset, BigInt(Math.max(0, Math.round(value * 1_000_000))), false);
		offset += 8;
	};
	bytes(RESPONSE_MAGIC);
	u16(response.status);
	u64(response.upstreamMs);
	u64(response.goPrepMs);
	u16(headers.length);
	for (const [key, values] of headers) {
		u16(key.length);
		bytes(key);
		u16(values.length);
		for (const value of values) {
			u32(value.length);
			bytes(value);
		}
	}
	u32(response.body.length);
	bytes(response.body);
	return out;
}

export function decodeDispatchResponse(data: Uint8Array): BinaryDispatchResponse {
	const reader = frameReader(data);
	assertMagic(reader.bytes(4), RESPONSE_MAGIC, "response");
	const status = reader.u16();
	const upstreamMs = Number(reader.u64()) / 1_000_000;
	const goPrepMs = Number(reader.u64()) / 1_000_000;
	const headerCount = reader.u16();
	const headers: Record<string, string[]> = {};
	for (let i = 0; i < headerCount; i++) {
		const key = reader.string(reader.u16());
		const valueCount = reader.u16();
		const values: string[] = [];
		for (let j = 0; j < valueCount; j++) values.push(reader.string(reader.u32()));
		headers[key] = values;
	}
	const body = reader.bytes(reader.u32());
	reader.done();
	// `body` is already a view over an owned response buffer. Returning the
	// view avoids one full response copy before linejs parses it.
	return { status, headers, body, upstreamMs, goPrepMs };
}
