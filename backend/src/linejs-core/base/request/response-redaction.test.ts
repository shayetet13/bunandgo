import { describe, expect, test } from "bun:test";
import { safeResponseHeaders } from "./mod.ts";

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
