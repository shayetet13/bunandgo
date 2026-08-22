import { Hono } from "hono";
import { z } from "zod";
import { formatZodError } from "../validate.ts";
import { requestUser, requireAdmin } from "../../auth/request-user.ts";
import {
	createUser,
	deleteUserRecord,
	getUser,
	listUsers,
	MAX_BOT_QUOTA,
	setUserActive,
	setUserBotQuota,
	setUserExemptIdLock,
	UserValidationError,
} from "../../auth/users.ts";
import { overQuotaBots } from "../../bot/bots.ts";
import { roomCoverageReport } from "../../bot/room-coverage.ts";
import { listActiveSessions } from "../../auth/session.ts";
import { deleteBotSession, enforceBotQuota, stopBot } from "../../bot/session-manager.ts";
import { inWorkerScope, WorkerScopeError } from "../../bot/worker-scope.ts";
import { clearStartConfirmationsForBot } from "../../bot/start-confirmation.ts";
import { logUserAction } from "../../auth/user-actions.ts";

export const usersRoute = new Hono();

usersRoute.use("*", requireAdmin);

usersRoute.get("/", (c) => c.json(listUsers()));

// Which OpenChats each user's bots actually sit in, and how many — see
// room-coverage.ts. Read-only, derived entirely from existing chats/bots.
usersRoute.get("/room-coverage", (c) => c.json(roomCoverageReport()));

// Who is logged into the dashboard right now, most recently active first —
// distinct from /logs/user-actions, which is history rather than live state.
usersRoute.get("/active-sessions", (c) => c.json(listActiveSessions()));

const createUserBodySchema = z.object({ username: z.string(), password: z.string() });

usersRoute.post("/", async (c) => {
	const result = createUserBodySchema.safeParse(await c.req.json().catch(() => undefined));
	if (!result.success) return c.json({ error: formatZodError(result.error) }, 400);
	try {
		const created = createUser(result.data.username, result.data.password);
		logUserAction(requestUser(c)!, "user.create", { targetUserId: created.id, username: created.username });
		return c.json(created, 201);
	} catch (error) {
		if (error instanceof UserValidationError) return c.json({ error: error.message }, 400);
		throw error;
	}
});

const patchUserBodySchema = z
	.object({
		active: z.boolean().optional(),
		botQuota: z.number().int().min(1).max(MAX_BOT_QUOTA).optional(),
		exemptIdLock: z.boolean().optional(),
	})
	.refine((data) => data.active !== undefined || data.botQuota !== undefined || data.exemptIdLock !== undefined, {
		message: "at least one field is required",
	});

usersRoute.patch("/:id", async (c) => {
	const id = Number(c.req.param("id"));
	const result = patchUserBodySchema.safeParse(await c.req.json().catch(() => undefined));
	if (!Number.isInteger(id) || id <= 0 || !result.success) {
		return c.json({ error: result.success ? "invalid user id" : formatZodError(result.error) }, 400);
	}
	const user = getUser(id);
	if (!user || user.role === "admin") return c.json({ error: "user not found" }, 404);
	let stopped: Array<{ id: number; name: string }> = [];
	try {
		if (result.data.active === false) {
			// listBotsForUser() is scope-filtered for dashboard display (see
			// bots.ts) — using it here would silently skip stopping any bot
			// this process doesn't run, leaving a "deactivated" user's bots
			// on another worker still online with nothing pointing at why.
			// overQuotaBots(id, 0) reuses the same unscoped owner query with
			// a quota of zero, i.e. "every bot this user owns."
			const allBots = overQuotaBots(id, 0);
			if (allBots.some((bot) => !inWorkerScope(bot.ownerUserId))) {
				return c.json(
					{ error: "บอทบางตัวของผู้ใช้นี้อยู่ภายใต้ worker อื่น กรุณาปิดการใช้งานจากหน้าควบคุมของ worker ที่ดูแลบอทของผู้ใช้คนนี้" },
					409,
				);
			}
			allBots.forEach((bot) => stopBot(bot.id));
		}
		if (result.data.active !== undefined) {
			setUserActive(id, result.data.active);
			logUserAction(requestUser(c)!, "user.set_active", { targetUserId: id, active: result.data.active });
		}
		if (result.data.botQuota !== undefined) {
			// enforceBotQuota() runs — and can refuse — before the quota is
			// persisted, so a refusal (bots on another worker) never leaves
			// the new quota committed with nothing actually enforcing it.
			stopped = enforceBotQuota(id, result.data.botQuota).map((bot) => ({ id: bot.id, name: bot.name }));
			setUserBotQuota(id, result.data.botQuota);
			// Applied before the response so the admin's next screen already
			// reflects it. Lowering a quota that leaves bots behind is the
			// whole point of the confirmation the dashboard shows first.
			logUserAction(requestUser(c)!, "user.set_bot_quota", {
				targetUserId: id,
				botQuota: result.data.botQuota,
				stoppedBotIds: stopped.map((bot) => bot.id),
			});
		}
		if (result.data.exemptIdLock !== undefined) {
			setUserExemptIdLock(id, result.data.exemptIdLock);
			logUserAction(requestUser(c)!, "user.set_exempt_id_lock", { targetUserId: id, exemptIdLock: result.data.exemptIdLock });
		}
	} catch (error) {
		if (error instanceof UserValidationError) return c.json({ error: error.message }, 400);
		if (error instanceof WorkerScopeError) return c.json({ error: error.message }, 409);
		throw error;
	}
	return c.json({ ...getUser(id), stoppedBots: stopped });
});

/**
 * What lowering a quota to `quota` would shut off, without doing it.
 *
 * The dashboard asks before it acts so the confirmation can name the bots
 * by name rather than a count — "ปิด 4 ตัว" and "ปิด บอทงาน3, บอทงาน4…"
 * are very different things to click OK on.
 */
usersRoute.get("/:id/quota-preview", (c) => {
	const id = Number(c.req.param("id"));
	const quota = Number(c.req.query("quota"));
	if (!Number.isInteger(id) || id <= 0) return c.json({ error: "invalid user id" }, 400);
	if (!Number.isInteger(quota) || quota < 1 || quota > MAX_BOT_QUOTA) {
		return c.json({ error: `โควตาบอทต้องเป็นจำนวนเต็ม 1-${MAX_BOT_QUOTA}` }, 400);
	}
	const user = getUser(id);
	if (!user || user.role === "admin") return c.json({ error: "user not found" }, 404);
	// This is an admin-wide preview, so it must not use listBotsForUser():
	// that helper intentionally hides bots owned by another worker process.
	// Showing `botCount: 0` while listing bots that will be stopped is both
	// confusing and unsafe for a destructive confirmation.
	const owned = overQuotaBots(id, 0);
	return c.json({
		currentQuota: user.botQuota,
		nextQuota: quota,
		botCount: owned.length,
		willStop: overQuotaBots(id, quota).map((bot) => ({ id: bot.id, name: bot.name, status: bot.status })),
	});
});

usersRoute.delete("/:id", (c) => {
	const id = Number(c.req.param("id"));
	if (!Number.isInteger(id) || id <= 0) return c.json({ error: "invalid user id" }, 400);
	const user = getUser(id);
	if (!user || user.role === "admin") return c.json({ error: "user not found" }, 404);
	// Account deletion is irreversible. Do not remove the user record while a
	// different worker still owns any of its bot sessions: the old
	// scope-filtered list silently left those sessions running as orphaned
	// bots. The admin can retry through the worker that owns the account.
	const allBots = overQuotaBots(id, 0);
	if (allBots.some((bot) => !inWorkerScope(bot.ownerUserId))) {
		return c.json(
			{ error: "บอทบางตัวของผู้ใช้นี้อยู่ภายใต้ worker อื่น กรุณาลบบัญชีจากหน้าควบคุมของ worker ที่ดูแลบอทของผู้ใช้คนนี้" },
			409,
		);
	}
	allBots.forEach((bot) => {
		deleteBotSession(bot.id);
		clearStartConfirmationsForBot(bot.id);
	});
	if (!deleteUserRecord(id)) return c.json({ error: "user not found" }, 404);
	logUserAction(requestUser(c)!, "user.delete", { targetUserId: id, username: user.username });
	return c.json({ ok: true });
});
