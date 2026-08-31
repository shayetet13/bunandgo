import { describe, expect, test } from "bun:test";
import { safeRequestHeaders, safeResponseHeaders } from "./mod.ts";

describe("LINE response log redaction", () => {
	test("keeps diagnostics but removes session-bearing headers", () => {
		const headers = new Headers({
			server: "legy",
			"x-line-next-access": "live-session-token",
			"set-cookie": "session=secret",
		});
		const safe = safeResponseHeaders(headers);
		expect(safe).toContainEqual(["server", "legy"]);
		expect(safe).toContainEqual(["x-line-next-access", "[REDACTED]"]);
		expect(safe).toContainEqual(["set-cookie", "[REDACTED]"]);
		expect(JSON.stringify(safe)).not.toContain("live-session-token");
		expect(JSON.stringify(safe)).not.toContain("session=secret");
	});
});

describe("LINE outgoing request log redaction", () => {
	test("keeps diagnostics but removes the live bearer token", () => {
		// Regression test: request/mod.ts and service/talk/mod.ts both log
		// their outgoing headers under LINEJS_DEBUG_LOGS=1, and those headers
		// carry the live x-line-access token from getHeader() -- this used to
		// go out unredacted despite safeResponseHeaders existing for the
		// exact same value on the response side.
		const headers = {
			"x-line-application": "DESKTOPWIN",
			"x-line-access": "live-session-token",
		};
		const safe = safeRequestHeaders(headers);
		expect(safe["x-line-application"]).toBe("DESKTOPWIN");
		expect(safe["x-line-access"]).toBe("[REDACTED]");
		expect(JSON.stringify(safe)).not.toContain("live-session-token");
	});
});
