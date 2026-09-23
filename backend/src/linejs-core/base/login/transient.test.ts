import { describe, expect, test } from "bun:test";
import { isPollExpiry, isTransientTransportFailure } from "./transient.ts";

// Verbatim from the VPS journal, where these ended QR logins that were
// otherwise fine and replaced the code mid-scan.
const RELAY_GOAWAY =
	'binary dispatch relay error: HTTP 502 upstream: Post "https://gf.line.naver.jp/enc": ' +
	'http2: server sent GOAWAY and closed the connection; LastStreamID=19, ErrCode=NO_ERROR, debug=""';
const GONE_410 = 'Request internal failed: status=410 headers=[["server","legy"]] body=<>';

describe("isTransientTransportFailure", () => {
	test("recognises the relay's GOAWAY report", () => {
		expect(isTransientTransportFailure(RELAY_GOAWAY)).toBe(true);
	});

	test("recognises dropped sockets by their platform error codes", () => {
		for (const message of [
			"fetch failed",
			"read ECONNRESET",
			"connect ECONNREFUSED 127.0.0.1:4790",
			"socket hang up",
			"unexpected EOF",
			"Unable to connect. Is the computer able to access the url?",
		]) {
			expect(isTransientTransportFailure(message)).toBe(true);
		}
	});

	test("leaves LINE's own answers alone — those are real login outcomes", () => {
		for (const message of [
			'Request internal failed, qrCodeLoginV2ForSecure(/acct/lgn/sq/v1) -> {"code":"NOT_AUTHORIZED_DEVICE"}',
			'{"errorCode":"AUTHENTICATION_FAILURE","reason":"You don\'t have permission to access this section."}',
			GONE_410,
			"checkQrCodeVerified timed out",
		]) {
			expect(isTransientTransportFailure(message)).toBe(false);
		}
	});

	test("does not mistake a 5-digit number for a 5xx status", () => {
		expect(isTransientTransportFailure("sent 50234 bytes")).toBe(false);
	});
});

describe("isPollExpiry", () => {
	test("treats a spent long-poll as another tick of the wait", () => {
		for (const message of ["The operation timed out", "status=408", GONE_410]) {
			expect(isPollExpiry(message)).toBe(true);
		}
	});

	test("does not swallow an authentication answer", () => {
		expect(isPollExpiry('{"errorCode":"AUTHENTICATION_FAILURE"}')).toBe(false);
	});
});
