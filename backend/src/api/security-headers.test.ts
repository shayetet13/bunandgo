import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { securityHeaders } from "./security-headers.ts";

const app = new Hono();
app.use("*", securityHeaders);
app.get("/api/private", (c) => c.json({ ok: true }));
app.get("/asset.js", (c) => c.text("asset"));

describe("security response headers", () => {
	test("prevents storage and framing of API responses", async () => {
		const response = await app.request("/api/private", { headers: { "x-forwarded-proto": "https" } });
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("pragma")).toBe("no-cache");
		expect(response.headers.get("x-frame-options")).toBe("DENY");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("strict-transport-security")).toContain("max-age=31536000");
	});

	test("does not disable caching for static paths", async () => {
		expect((await app.request("/asset.js")).headers.get("cache-control")).toBeNull();
	});
});
