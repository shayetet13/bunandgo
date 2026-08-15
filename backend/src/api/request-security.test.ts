import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { rejectCrossSiteWrite, rejectUntrustedWebSocketOrigin } from "./request-security.ts";

const app = new Hono();
app.use("/api/*", rejectCrossSiteWrite);
app.use("/ws", rejectUntrustedWebSocketOrigin);
app.post("/api/change", (c) => c.json({ ok: true }));
app.get("/ws", (c) => c.text("upgrade allowed"));

describe("browser request origin checks", () => {
	test("rejects cross-site API writes", async () => {
		for (const headers of [
			{ origin: "https://evil.example" },
			{ "sec-fetch-site": "cross-site" },
		]) {
			expect((await app.request("/api/change", { method: "POST", headers })).status).toBe(403);
		}
	});

	test("allows the configured browser origin and non-browser callers", async () => {
		expect((await app.request("/api/change", {
			method: "POST",
			headers: { origin: "http://localhost:5173", "sec-fetch-site": "same-origin" },
		})).status).toBe(200);
		expect((await app.request("/api/change", { method: "POST" })).status).toBe(200);
	});

	test("allows the production same-origin host supplied by the trusted gateway", async () => {
		expect((await app.request("https://dakotabot.site/api/change", {
			method: "POST",
			headers: {
				host: "dakotabot.site",
				origin: "https://dakotabot.site",
				"x-forwarded-proto": "https",
				"sec-fetch-site": "same-origin",
			},
		})).status).toBe(200);
	});

	test("rejects a websocket opened by an untrusted page", async () => {
		expect((await app.request("/ws", { headers: { origin: "https://evil.example" } })).status).toBe(403);
		expect((await app.request("/ws", { headers: { origin: "http://localhost:5173" } })).status).toBe(200);
	});
});
