import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { decodeLegyHeaders, encodeLegyHeaders } from "./legy.ts";

describe("encodeLegyHeaders / decodeLegyHeaders", () => {
	test("round-trips an empty header set", () => {
		const encoded = encodeLegyHeaders({});
		const { headers, data } = decodeLegyHeaders(encoded);
		expect(headers).toEqual({});
		expect(data.length).toBe(0);
	});

	test("round-trips multiple headers plus trailing body bytes", () => {
		const encoded = encodeLegyHeaders({ "x-lpqs": "/S3", "x-lt": "token-value" });
		const body = Buffer.from("payload bytes follow", "utf-8");
		const { headers, data } = decodeLegyHeaders(Buffer.concat([encoded, body]));
		expect(headers).toEqual({ "x-lpqs": "/S3", "x-lt": "token-value" });
		expect(data.toString("utf-8")).toBe("payload bytes follow");
	});

	test("throws a clean, labeled error instead of a raw Buffer RangeError when the response is truncated mid-header", () => {
		// A network hiccup (lane closing mid-response, short read) can hand back
		// a decrypted body shorter than the header block it declares -- this is
		// exactly the shape that produced the live "LegyPusherError ... offset
		// out of range ... Received 49150" incident at keepalive noop().
		const encoded = encodeLegyHeaders({ "x-lpqs": "/S3", "x-lt": "a-fairly-long-token-value" });
		const truncated = encoded.subarray(0, encoded.length - 5);

		let thrown: unknown;
		try {
			decodeLegyHeaders(truncated);
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).name).toBe("LegyProtocolError");
		expect((thrown as Error).message).not.toMatch(/is out of range/i);
		expect((thrown as Error).message).toContain("decodeLegyHeaders");
	});

	test("throws a labeled error instead of looping on a garbage/implausible header count", () => {
		// count=0xffff with no real entries behind it -- must not spin through
		// 65535 iterations reading garbage as if it were valid.
		const garbage = Buffer.from([0x00, 0x02, 0xff, 0xff]);
		expect(() => decodeLegyHeaders(garbage)).toThrow(/implausible header count|response is likely corrupted/i);
	});

	test("throws a labeled error when the declared body length exceeds the actual response size", () => {
		const garbage = Buffer.from([0xff, 0xff, 0x00, 0x00]);
		expect(() => decodeLegyHeaders(garbage)).toThrow(/declared body length/i);
	});
});
