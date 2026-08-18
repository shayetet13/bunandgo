import { describe, expect, test } from "bun:test";
import { decodeDispatchResponse, encodeDispatchRequest } from "./binary-protocol.ts";

function pushU16(out: number[], value: number): void {
	out.push((value >>> 8) & 0xff, value & 0xff);
}

function pushU32(out: number[], value: number): void {
	out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function pushU64(out: number[], value: bigint): void {
	for (let shift = 56n; shift >= 0n; shift -= 8n) out.push(Number((value >> shift) & 0xffn));
}

function pushString(out: number[], value: string, length: "u16" | "u32"): void {
	const bytes = [...new TextEncoder().encode(value)];
	if (length === "u16") pushU16(out, bytes.length);
	else pushU32(out, bytes.length);
	out.push(...bytes);
}

describe("binary dispatch protocol", () => {
	test("encodes a compact single-allocation request frame", () => {
		const wire = encodeDispatchRequest({
			method: "POST",
			url: "https://line.test/CA5",
			headers: { "x-line-access": "token" },
			body: new Uint8Array([1, 2, 3]),
		});

		expect(new TextDecoder().decode(wire.subarray(0, 4))).toBe("LDB1");
		expect(wire.length).toBeGreaterThan(40);
		expect([...wire.slice(-3)]).toEqual([1, 2, 3]);
	});

	test("decodes Go's response frame including timing and repeated headers", () => {
		const out = [...new TextEncoder().encode("LDR1")];
		pushU16(out, 201);
		pushU64(out, 32_500_000n);
		pushU64(out, 250_000n);
		pushU16(out, 1);
		pushString(out, "set-cookie", "u16");
		pushU16(out, 2);
		pushString(out, "a=1", "u32");
		pushString(out, "b=2", "u32");
		pushU32(out, 3);
		out.push(7, 8, 9);

		const decoded = decodeDispatchResponse(Uint8Array.from(out));
		expect(decoded).toEqual({
			status: 201,
			headers: { "set-cookie": ["a=1", "b=2"] },
			body: new Uint8Array([7, 8, 9]),
			upstreamMs: 32.5,
			goPrepMs: 0.25,
		});
	});
});
