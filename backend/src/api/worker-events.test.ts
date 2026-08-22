import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createBot } from "../bot/bots.ts";

process.env.DISPATCH_TOKEN ??= "worker-events-test-token";
const { botEvents } = await import("../bot/session-manager.ts");
const { relayedLatencySamples, workerEventsRoute } = await import("./worker-events.ts");
const { CONTROL_TOKEN_HEADER } = await import("./worker-proxy.ts");

const ENV_KEYS = ["WORKER_OWNER_SCOPE", "WORKER_OWNER_EXCLUDE", "WORKER_OWNER_ROUTES", "CONTROL_PLANE_URL", "CONTROL_PLANE_TOKEN"] as const;
const original = new Map<string, string | undefined>();

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
	for (const key of ENV_KEYS) {
		if (!original.has(key)) original.set(key, process.env[key]);
		const value = values[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = original.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	original.clear();
});

describe("worker event fan-in", () => {
	test("authenticates a shard batch and re-emits only deliberately routed owners", async () => {
		const remoteOwner = 838383;
		const localOwner = 848484;
		const remoteBot = createBot("remote event bot", "DESKTOPWIN", remoteOwner);
		const localBot = createBot("local event bot", "DESKTOPWIN", localOwner);
		const token = "e".repeat(32);
		setEnv({
			WORKER_OWNER_EXCLUDE: String(remoteOwner),
			WORKER_OWNER_ROUTES: `${remoteOwner}=http://127.0.0.1:8792`,
			CONTROL_PLANE_TOKEN: token,
		});

		const received: unknown[] = [];
		const listener = (data: unknown) => received.push(data);
		botEvents.on("bot_status", listener);
		try {
			const app = new Hono();
			app.route("/internal/worker-events", workerEventsRoute);
			const body = {
				workerId: "shard-b",
				events: [
					{ id: "shard-b:1", type: "bot_status", data: { botId: remoteBot.id, status: "online" } },
					{ id: "shard-b:2", type: "bot_status", data: { botId: localBot.id, status: "online" } },
					{ id: "shard-b:3", type: "not_allowed", data: { botId: remoteBot.id } },
					{
						id: "shard-b:4",
						type: "send_result",
						data: {
							last: {
								botId: remoteBot.id,
								ts: 1234,
								surface: "square",
								targetMid: null,
								latencyMs: 21,
								ok: true,
								source: "auto",
								textPreview: null,
							},
						},
					},
				],
			};
			const response = await app.request("/internal/worker-events", {
				method: "POST",
				headers: { "content-type": "application/json", [CONTROL_TOKEN_HEADER]: token },
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(202);
			expect(await response.json()).toEqual({ accepted: 2 });
			expect(received).toEqual([{ botId: remoteBot.id, status: "online" }]);
			expect(relayedLatencySamples(1)[0]).toMatchObject({ botId: remoteBot.id, latencyMs: 21 });

			const duplicate = await app.request("/internal/worker-events", {
				method: "POST",
				headers: { "content-type": "application/json", [CONTROL_TOKEN_HEADER]: token },
				body: JSON.stringify(body),
			});
			expect(await duplicate.json()).toEqual({ accepted: 0 });
			expect(received).toHaveLength(1);

			const forbidden = await app.request("/internal/worker-events", {
				method: "POST",
				headers: { "content-type": "application/json", [CONTROL_TOKEN_HEADER]: "wrong" },
				body: JSON.stringify(body),
			});
			expect(forbidden.status).toBe(403);
		} finally {
			botEvents.off("bot_status", listener);
		}
	});
});
