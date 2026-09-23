import { describe, expect, test } from "bun:test";
import { Protocols, Thrift } from "./mod.ts";

describe("Thrift fast ACK validator", () => {
	test("accepts field 0 success and rejects an exception field", () => {
		const thrift = new Thrift();
		const success = thrift.writeThrift([[12, 0, [[8, 1, 123]]]], "sendMessage", Protocols[4]);
		const error = thrift.writeThrift([[12, 1, [[8, 1, 123]]]], "sendMessage", Protocols[4]);

		expect(thrift.isSuccessfulResponse(success, Protocols[4])).toBe(true);
		expect(thrift.isSuccessfulResponse(error, Protocols[4])).toBe(false);
	});
});
