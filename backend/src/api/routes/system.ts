import { Hono } from "hono";
import { requireAdmin, requestUser } from "../../auth/request-user.ts";
import { logUserActionImmediately } from "../../auth/user-actions.ts";
import { readWorkerTopology } from "../../bot/worker-topology.ts";
import { db } from "../../db/sqlite.ts";

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

	return route;
}

export const systemRoute = createSystemRoute();
