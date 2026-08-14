import { stat, writeFile } from "node:fs/promises";
import { Hono } from "hono";
import { requireAdmin, requestUser } from "../../auth/request-user.ts";
import { logUserActionImmediately } from "../../auth/user-actions.ts";
import { readWorkerTopology } from "../../bot/worker-topology.ts";

const RESTART_UNIT = "linebot-worker.service";
const RESTART_PATH_UNIT = "linebot-worker-restart.path";
const RESTART_TRIGGER_PATH = "/opt/linebot/shared/restart-linebot-worker.trigger";
const RESTART_CONFIRMATION = "restart-linebot-worker";
const RESTART_COOLDOWN_MS = 60_000;

interface SystemRouteOptions {
	triggerPath?: string;
	now?: () => number;
	isRestartAgentActive?: () => Promise<boolean>;
	isShardWorker?: () => boolean;
}

async function productionRestartAgentActive(): Promise<boolean> {
	try {
		const child = Bun.spawn(["/usr/bin/systemctl", "is-active", "--quiet", RESTART_PATH_UNIT], { stdout: "ignore", stderr: "ignore" });
		return (await child.exited) === 0;
	} catch {
		return false;
	}
}

async function markerAgeMs(path: string, now: number): Promise<number | undefined> {
	try {
		return Math.max(0, now - (await stat(path)).mtimeMs);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Factory keeps the fixed production target testable without an OS restart. */
export function createSystemRoute(options: SystemRouteOptions = {}): Hono {
	const route = new Hono();
	const triggerPath = options.triggerPath ?? RESTART_TRIGGER_PATH;
	const now = options.now ?? Date.now;
	const isRestartAgentActive = options.isRestartAgentActive ?? productionRestartAgentActive;
	const isShardWorker = options.isShardWorker ?? (() => !!readWorkerTopology().controlPlaneUrl);

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

		if (!(await isRestartAgentActive())) {
			return c.json({ error: "ระบบ restart agent ยังไม่ได้ติดตั้งหรือไม่ได้ทำงาน" }, 503);
		}

		const requestedAt = now();
		const ageMs = await markerAgeMs(triggerPath, requestedAt);
		if (ageMs !== undefined && ageMs < RESTART_COOLDOWN_MS) {
			const retryAfterSeconds = Math.max(1, Math.ceil((RESTART_COOLDOWN_MS - ageMs) / 1_000));
			c.header("Retry-After", String(retryAfterSeconds));
			return c.json({ error: `เพิ่งสั่งรีสตาร์ทไป กรุณารออีก ${retryAfterSeconds} วินาที` }, 429);
		}

		const user = requestUser(c)!;
		// Commit the audit row synchronously before touching the path watched by
		// systemd. The helper deliberately waits two seconds so this response can
		// reach the browser before the process receives SIGTERM.
		logUserActionImmediately(user, "system.worker.restart.requested", { unit: RESTART_UNIT });
		await writeFile(triggerPath, `${requestedAt}\n`, { encoding: "utf8", mode: 0o600 });

		return c.json({ ok: true, unit: RESTART_UNIT, requestedAt }, 202);
	});

	return route;
}

export const systemRoute = createSystemRoute();
