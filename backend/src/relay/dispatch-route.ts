import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { H2_LANE_ROLE_HEADER, laneFetch, laneRaceView, laneStats } from "../dispatch/h2-lanes.ts";
import { relayConfig } from "./config.ts";

function safeTokenEqual(left: string | undefined, right: string | undefined): boolean {
	if (!left || !right) return false;
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}

export const relayRoute = new Hono();

relayRoute.get("/healthz", (c) => {
	const lanes = laneStats();
	const origins = relayConfig.lineOrigins.map((origin) => ({
		origin,
		ready: lanes.filter((lane) => lane.origin === origin && lane.state === "ready").length,
		total: lanes.filter((lane) => lane.origin === origin).length,
	}));
	const healthy = origins.every((origin) => origin.ready > 0 && origin.ready === origin.total);
	return c.json({ healthy, workerId: relayConfig.workerId, reportIntervalMs: relayConfig.reportIntervalMs, origins }, healthy ? 200 : 503);
});

/** Manual/debug read of this box's own lanes — the control plane gets the
 * same shape pushed to it periodically, see report-client.ts. */
relayRoute.get("/stats", (c) => c.json({ workerId: relayConfig.workerId, lanes: laneStats(), races: laneRaceView() }));

const dispatchSchema = z.object({
	method: z.string().min(1).max(10),
	url: z.string().url(),
	headers: z.record(z.string(), z.string()).default({}),
	bodyBase64: z.string().optional(),
	/** Which lane-race bucket this counts against on this box, mirroring the
	 * same header h2-lanes.ts reads locally — see H2_LANE_ROLE_HEADER. */
	role: z.enum(["send", "poll", "warm"]).optional(),
});

/**
 * Executes one HTTP request this box's owned h2-lanes pool (falling back to
 * plain fetch, exactly like `dispatch/client.ts`'s `fetchLineDirect` does on
 * the main backend) and returns the raw response. This box never inspects
 * LINE-protocol semantics — same "just relay bytes" contract as the existing
 * Go sender, just crossing a network hop instead of loopback.
 */
relayRoute.post("/dispatch", async (c) => {
	if (!safeTokenEqual(c.req.header("x-lane-relay-token"), relayConfig.dispatchToken)) {
		return c.json({ error: "forbidden" }, 403);
	}
	const parsed = dispatchSchema.safeParse(await c.req.json().catch(() => undefined));
	if (!parsed.success) return c.json({ error: "invalid dispatch request" }, 400);
	const { method, url, headers, bodyBase64, role } = parsed.data;
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return c.json({ error: "invalid dispatch URL" }, 400);
	}
	if (!relayConfig.lineOrigins.includes(target.origin)) {
		return c.json({ error: "dispatch origin is not allowed" }, 403);
	}

	const requestHeaders: Record<string, string> = { ...headers };
	if (role) requestHeaders[H2_LANE_ROLE_HEADER] = role;
	const body = bodyBase64 ? Buffer.from(bodyBase64, "base64") : undefined;

	const startedAt = performance.now();
	try {
		const laneResponse = await laneFetch(target, { method, headers: requestHeaders, body });
		const response = laneResponse ?? (await globalThis.fetch(target, { method, headers: requestHeaders, body }));
		const responseBody = new Uint8Array(await response.arrayBuffer());
		return c.json({
			status: response.status,
			headers: Object.fromEntries(response.headers.entries()),
			bodyBase64: Buffer.from(responseBody).toString("base64"),
			tookMs: performance.now() - startedAt,
			viaOwnedLane: laneResponse !== undefined,
		});
	} catch (error) {
		// Mirrors laneFetch's own contract: a caught error here means the
		// caller cannot tell whether LINE received the request, so it must
		// never be retried blindly on the control-plane side either.
		return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
	}
});
