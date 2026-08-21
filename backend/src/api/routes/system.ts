import { Hono } from "hono";
import { requireAdmin, requestUser } from "../../auth/request-user.ts";
import { logUserActionImmediately } from "../../auth/user-actions.ts";
import { isMaintenanceModeEnabled, setMaintenanceMode } from "../../bot/maintenance-mode.ts";
import { testHardTimeoutBurst, testLaneRelayBurst } from "../../bot/session-manager.ts";
import { readWorkerTopology } from "../../bot/worker-topology.ts";
import { db } from "../../db/sqlite.ts";
import { applyHedgeConfig, hedgeConfig, hedgeShadowReport, parseHedgeConfig } from "../../dispatch/hedge.ts";

const HARD_TIMEOUT_TEST_CONFIRMATION = "test-hard-timeout";
const HARD_TIMEOUT_TEST_MAX_COUNT = 30;
const HARD_TIMEOUT_TEST_MAX_TIMEOUT_MS = 500;

const LANE_RELAY_TEST_CONFIRMATION = "test-lane-relay";
const LANE_RELAY_TEST_MAX_COUNT = 150;

const RESTART_UNIT = "linebot-worker.service";
const RESTART_CONFIRMATION = "restart-linebot-worker";
const RESTART_COOLDOWN_MS = 60_000;
const RESTART_DELAY_MS = 2_000;
const RESTART_META_KEY = "system.worker.last_restart_requested_at";

const lastRestartStmt = db.prepare<{ value: string }, [string]>("SELECT value FROM app_meta WHERE key = ?");
const setLastRestartStmt = db.prepare<null, [string, string]>(
	"INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);

interface SystemRouteOptions {
	now?: () => number;
	isShardWorker?: () => boolean;
	restartAvailable?: () => boolean;
	scheduleRestart?: (delayMs: number) => void;
}

function productionRestartAvailable(): boolean {
	return process.env.NODE_ENV === "production" && !!process.env.INVOCATION_ID;
}

function productionScheduleRestart(delayMs: number): void {
	setTimeout(() => {
		// linebot-worker.service uses Restart=on-failure. Exiting non-zero asks
		// systemd to create a fresh process without granting this web process
		// sudo, D-Bus control, or access to any other service.
		process.exit(75);
	}, delayMs);
}

/** Factory keeps the production exit testable without terminating the test runner. */
export function createSystemRoute(options: SystemRouteOptions = {}): Hono {
	const route = new Hono();
	const now = options.now ?? Date.now;
	const isShardWorker = options.isShardWorker ?? (() => !!readWorkerTopology().controlPlaneUrl);
	const restartAvailable = options.restartAvailable ?? productionRestartAvailable;
	const scheduleRestart = options.scheduleRestart ?? productionScheduleRestart;

	route.use("*", requireAdmin);

	route.post("/restart-worker", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { confirm?: unknown };
		if (body.confirm !== RESTART_CONFIRMATION) {
			return c.json({ error: "กรุณายืนยันการรีสตาร์ทจากปุ่มในหน้า Settings" }, 400);
		}

		// A shard is intentionally loopback-only and must never be able to stop
		// the public control plane by proxying this endpoint to itself.
		if (isShardWorker()) {
			return c.json({ error: "สั่งรีสตาร์ท worker หลักได้จาก control plane เท่านั้น" }, 409);
		}

		if (!restartAvailable()) {
			return c.json({ error: "คำสั่งนี้ใช้งานได้เฉพาะ linebot-worker ที่รันผ่าน systemd" }, 503);
		}

		const requestedAt = now();
		const lastRequestedAt = Number(lastRestartStmt.get(RESTART_META_KEY)?.value ?? 0);
		const ageMs = Math.max(0, requestedAt - lastRequestedAt);
		if (lastRequestedAt > 0 && ageMs < RESTART_COOLDOWN_MS) {
			const retryAfterSeconds = Math.max(1, Math.ceil((RESTART_COOLDOWN_MS - ageMs) / 1_000));
			c.header("Retry-After", String(retryAfterSeconds));
			return c.json({ error: `เพิ่งสั่งรีสตาร์ทไป กรุณารออีก ${retryAfterSeconds} วินาที` }, 429);
		}

		const user = requestUser(c)!;
		// Commit both records synchronously before scheduling process exit. The
		// delay gives HTTP 202 enough time to reach the browser.
		logUserActionImmediately(user, "system.worker.restart.requested", { unit: RESTART_UNIT });
		setLastRestartStmt.run(RESTART_META_KEY, String(requestedAt));
		scheduleRestart(RESTART_DELAY_MS);

		return c.json({ ok: true, unit: RESTART_UNIT, requestedAt }, 202);
	});

	// Hedge stage 0-1 is read-side only: the report is computed from send
	// RTTs that lane racing already persists, so reading it — or flipping the
	// mode — never adds work to any reply path and never needs a restart.
	route.get("/hedge", (c) => {
		const hours = Number(c.req.query("hours") ?? "");
		return c.json(hedgeShadowReport(Number.isFinite(hours) && hours > 0 ? hours : undefined));
	});

	route.put("/hedge", async (c) => {
		const body = (await c.req.json().catch(() => undefined)) as unknown;
		let config;
		try {
			config = parseHedgeConfig(body);
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "รูปแบบการตั้งค่า hedge ไม่ถูกต้อง" }, 400);
		}
		const previous = hedgeConfig();
		const applied = applyHedgeConfig(config);
		const user = requestUser(c)!;
		logUserActionImmediately(user, "system.hedge.config.updated", { previous, applied });
		return c.json({ ok: true, config: applied });
	});

	// The bot itself never checks this — only the "user"-role console does
	// (see /api/auth/me). Flipping it never touches a running session.
	route.get("/maintenance-mode", (c) => {
		return c.json({ enabled: isMaintenanceModeEnabled() });
	});

	route.put("/maintenance-mode", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
		if (typeof body.enabled !== "boolean") {
			return c.json({ error: "enabled ต้องเป็น true หรือ false" }, 400);
		}
		setMaintenanceMode(body.enabled);
		const user = requestUser(c)!;
		logUserActionImmediately(user, "system.maintenance_mode.updated", { enabled: body.enabled });
		return c.json({ ok: true, enabled: body.enabled });
	});

	// TEMPORARY — live-conditions proof for the "hard drop anything over Nms"
	// idea raised 2026-08-20, before it is ever considered for the real reply
	// path. Fires `count` sequential sends, each aborted client-side if it
	// hasn't resolved within `timeoutMs`, into a caller-chosen bot/room, and
	// reports how many would have been delivered vs. dropped under that rule
	// against live network conditions right now. Remove this route once the
	// decision is made either way. Never point this at a real work room — the
	// confirm string is deliberate friction, not a hint to skip it.
	route.post("/hard-timeout-test", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as {
			confirm?: unknown;
			botId?: unknown;
			targetMid?: unknown;
			text?: unknown;
			count?: unknown;
			timeoutMs?: unknown;
		};
		if (body.confirm !== HARD_TIMEOUT_TEST_CONFIRMATION) {
			return c.json({ error: `ต้องยืนยันด้วย confirm: "${HARD_TIMEOUT_TEST_CONFIRMATION}"` }, 400);
		}
		const botId = Number(body.botId);
		if (!Number.isInteger(botId) || botId <= 0) {
			return c.json({ error: "botId ไม่ถูกต้อง" }, 400);
		}
		const targetMid = body.targetMid;
		if (typeof targetMid !== "string" || !/^m[0-9a-f]{32}$/i.test(targetMid)) {
			return c.json({ error: "targetMid ไม่ถูกต้อง (ต้องเป็นห้อง Square)" }, 400);
		}
		const count = Number(body.count);
		if (!Number.isInteger(count) || count <= 0 || count > HARD_TIMEOUT_TEST_MAX_COUNT) {
			return c.json({ error: `count ต้องเป็นจำนวนเต็ม 1-${HARD_TIMEOUT_TEST_MAX_COUNT}` }, 400);
		}
		const timeoutMs = body.timeoutMs === undefined ? 20 : Number(body.timeoutMs);
		if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > HARD_TIMEOUT_TEST_MAX_TIMEOUT_MS) {
			return c.json({ error: `timeoutMs ต้องเป็นจำนวนเต็ม 1-${HARD_TIMEOUT_TEST_MAX_TIMEOUT_MS}` }, 400);
		}
		const text = typeof body.text === "string" && body.text.trim()
			? body.text.trim()
			: `[hard-timeout test] ${timeoutMs}ms ceiling — ${new Date().toISOString()}`;

		const user = requestUser(c)!;
		try {
			const result = await testHardTimeoutBurst(botId, targetMid, text, count, timeoutMs);
			const delivered = result.results.filter((r) => r.delivered);
			const dropped = result.results.filter((r) => !r.delivered);
			const deliveredAvgMs = delivered.length > 0
				? delivered.reduce((sum, r) => sum + r.tookMs, 0) / delivered.length
				: undefined;
			logUserActionImmediately(user, "system.hard_timeout_test.fired", {
				botId,
				targetMid,
				count,
				timeoutMs,
				delivered: delivered.length,
				dropped: dropped.length,
			});
			return c.json({
				ok: true,
				...result,
				summary: { requested: count, delivered: delivered.length, dropped: dropped.length, deliveredAvgMs },
			});
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "ยิงทดสอบไม่สำเร็จ" }, 400);
		}
	});

	// TEMPORARY — ban-risk proof for routing real sends through the lane-relay
	// box (server3), raised 2026-08-21. Remove this route and
	// lane-relay-test-transport.ts once that question is answered either way.
	// Never point this at a real work room — the confirm string is
	// deliberate friction, not a hint to skip it.
	route.post("/lane-relay-test", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as {
			confirm?: unknown;
			botId?: unknown;
			targetMid?: unknown;
			text?: unknown;
			count?: unknown;
		};
		if (body.confirm !== LANE_RELAY_TEST_CONFIRMATION) {
			return c.json({ error: `ต้องยืนยันด้วย confirm: "${LANE_RELAY_TEST_CONFIRMATION}"` }, 400);
		}
		const botId = Number(body.botId);
		if (!Number.isInteger(botId) || botId <= 0) {
			return c.json({ error: "botId ไม่ถูกต้อง" }, 400);
		}
		const targetMid = body.targetMid;
		if (typeof targetMid !== "string" || !/^m[0-9a-f]{32}$/i.test(targetMid)) {
			return c.json({ error: "targetMid ไม่ถูกต้อง (ต้องเป็นห้อง Square)" }, 400);
		}
		const count = Number(body.count);
		if (!Number.isInteger(count) || count <= 0 || count > LANE_RELAY_TEST_MAX_COUNT) {
			return c.json({ error: `count ต้องเป็นจำนวนเต็ม 1-${LANE_RELAY_TEST_MAX_COUNT}` }, 400);
		}
		const text = typeof body.text === "string" && body.text.trim()
			? body.text.trim()
			: `[lane-relay test] via server3 — ${new Date().toISOString()}`;

		const user = requestUser(c)!;
		try {
			const result = await testLaneRelayBurst(botId, targetMid, text, count);
			const delivered = result.results.filter((r) => r.delivered);
			const failed = result.results.filter((r) => !r.delivered);
			logUserActionImmediately(user, "system.lane_relay_test.fired", {
				botId,
				targetMid,
				count,
				sent: result.results.length,
				delivered: delivered.length,
				failed: failed.length,
				abortedEarly: result.abortedEarly,
				distinctMessageIds: result.distinctMessageIds,
			});
			return c.json({
				ok: true,
				...result,
				summary: {
					requested: count,
					sent: result.results.length,
					delivered: delivered.length,
					failed: failed.length,
					distinctMessageIds: result.distinctMessageIds,
				},
			});
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "ยิงทดสอบไม่สำเร็จ" }, 400);
		}
	});

	return route;
}

export const systemRoute = createSystemRoute();
