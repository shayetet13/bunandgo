import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { formatZodError } from "../validate.ts";
import {
	clearStoredAuthToken,
	deleteBotSession,
	disarmScheduledPostTimer,
	getCurrentQr,
	prewarmReplyText,
	resyncChatsNow,
	stopBot,
	syncFastSquarePollers,
	syncScheduledPostTimer,
	testSend,
} from "../../bot/session-manager.ts";
import { clearStartConfirmationsForBot, createStartConfirmation } from "../../bot/start-confirmation.ts";
import { createRule, deleteRule, listRules, RuleValidationError, type RuleInput, updateRule } from "../../bot/rules.ts";
import {
	createScheduledPost,
	deleteScheduledPost,
	listScheduledPosts,
	ScheduledPostValidationError,
	type ScheduledPostInput,
	updateScheduledPost,
} from "../../bot/scheduled-posts.ts";
import { getBot, resetBotLockedLineMid, updateOwnerTesting } from "../../bot/bots.ts";
import { canAccessBot } from "../../bot/bots.ts";
import { WorkerScopeError } from "../../bot/worker-scope.ts";
import {
	listChatAdminAllowlist,
	MAX_SQUARE_CHATS_PER_BOT,
	setChatAdminAllowlist,
	setChatAdminOnly,
	setChatEnabled,
} from "../../bot/chat-access.ts";
import { isAdminRole, listSquareMembers } from "../../bot/square-roles.ts";
import { roomBotsFor, setPrimaryBot } from "../../bot/primary-bot.ts";
import { copyRoomConfig } from "../../bot/room-config-copy.ts";
import { requestUser, requireAdmin } from "../../auth/request-user.ts";
import { logUserAction } from "../../auth/user-actions.ts";
import { db } from "../../db/sqlite.ts";
import type { BotEventRow, ChatRow, LatencySampleRow, MessageInRow, Surface } from "../../db/schema.ts";
import { parseLimit } from "../limit.ts";

export const botDetailRoute = new Hono();

function botIdOf(c: Context): number {
	return Number(c.req.param("botId"));
}

botDetailRoute.use("*", async (c, next) => {
	const botId = botIdOf(c);
	if (!Number.isInteger(botId) || botId <= 0) {
		return c.json({ error: "invalid bot id" }, 400);
	}
	if (!getBot(botId)) return c.json({ error: "bot not found" }, 404);
	if (!canAccessBot(requestUser(c)!, botId)) return c.json({ error: "forbidden" }, 403);
	await next();
});

function isHttpOrigin(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

// Prefer the browser's own Origin header — it reflects whatever host/port the
// dashboard is actually being viewed at (works whether that's the public
// domain, a bare IP, or a LAN IP hitting the Vite dev server) and survives
// proxies that rewrite Host (Vite's dev proxy rewrites Host to its target,
// "localhost:8787", so relying on Host alone breaks local network testing).
// Deliberately not checked against config.allowedOrigins: that list is just
// the dev default (localhost:5173) unless ALLOWED_ORIGINS is set, so
// enforcing it here would break exactly the LAN-IP case this is meant to
// support. This route already requires an authenticated session — a caller
// who'd spoof this header already holds a valid confirm token directly and
// gains nothing by mis-labeling the link, so this only needs to reject
// garbage (e.g. the literal "null" some browsers send for opaque origins),
// not enforce a fixed allow-list.
// Falls back to Host/X-Forwarded-Proto (nginx sets these) for non-browser
// callers that don't send Origin, then to c.req.url as a last resort.
function publicOrigin(c: Context): string {
	const origin = c.req.header("origin");
	if (origin && isHttpOrigin(origin)) return origin;
	const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? new URL(c.req.url).host;
	const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "");
	return `${proto}://${host}`;
}

function ruleIdOf(c: Context): number | undefined {
	const id = Number(c.req.param("id"));
	return Number.isInteger(id) && id > 0 ? id : undefined;
}

const chatsStmt = db.prepare<ChatRow, [number]>("SELECT * FROM chats WHERE bot_id = ? ORDER BY joined_at DESC");

const chatByMidStmt = db.prepare<ChatRow, [number, string]>("SELECT * FROM chats WHERE bot_id = ? AND mid = ?");

botDetailRoute.post("/start", (c) => {
	const botId = botIdOf(c);
	const bot = getBot(botId);
	if (!bot) return c.json({ error: "bot not found" }, 404);
	if (bot.status !== "offline") {
		return c.json({ error: "bot is already running" }, 409);
	}
	// Real login doesn't start yet — the dashboard shows a decoy QR pointing
	// at /confirm/:token (ban-risk warnings + ตกลง/ยกเลิก) first. Accepting
	// that is what actually calls startBot(); see start-confirmation.ts.
	const token = createStartConfirmation(botId);
	const origin = publicOrigin(c);
	logUserAction(requestUser(c)!, "bot.start_requested", { botId });
	return c.json({ ok: true, confirmToken: token, confirmUrl: `${origin}/confirm/${token}` });
});

botDetailRoute.post("/stop", (c) => {
	const botId = botIdOf(c);
	try {
		stopBot(botId);
	} catch (error) {
		if (error instanceof WorkerScopeError) return c.json({ error: error.message }, 409);
		throw error;
	}
	logUserAction(requestUser(c)!, "bot.stop", { botId });
	return c.json({ ok: true });
});

botDetailRoute.delete("/", (c) => {
	const botId = botIdOf(c);
	try {
		deleteBotSession(botId);
	} catch (error) {
		if (error instanceof WorkerScopeError) return c.json({ error: error.message }, 409);
		throw error;
	}
	clearStartConfirmationsForBot(botId);
	logUserAction(requestUser(c)!, "bot.delete", { botId });
	return c.json({ ok: true });
});

// REST fallback for the `qr`/`pincode` WS events, which only ever fire once.
// A dashboard tab reconnecting in the gap between a failed login attempt and
// its retry otherwise never sees the fresh QR the retry generated. Gated on
// "connecting" so a stale value left over from a finished attempt is never
// handed back as if it were still current.
botDetailRoute.get("/qr", (c) => {
	const botId = botIdOf(c);
	const bot = getBot(botId);
	if (bot?.status !== "connecting") return c.json({});
	return c.json(getCurrentQr(botId) ?? {});
});

const settingsBodySchema = z.object({
	allowOwnerTesting: z.boolean(),
});

botDetailRoute.patch("/settings", async (c) => {
	const result = settingsBodySchema.safeParse(await c.req.json().catch(() => undefined));
	if (!result.success) return c.json({ error: formatZodError(result.error) }, 400);
	const botId = botIdOf(c);
	if (!updateOwnerTesting(botId, result.data.allowOwnerTesting)) return c.json({ error: "bot not found" }, 404);
	logUserAction(requestUser(c)!, "bot.owner_testing_toggle", { botId, allowOwnerTesting: result.data.allowOwnerTesting });
	const bot = getBot(botId);
	if (!bot) return c.json({ error: "bot not found" }, 404);
	return c.json(bot);
});

// Admin-only recovery for a single bot's one-LINE-account lock (see
// bot/bots.ts evaluateIdLock) — e.g. its LINE account was banned and a
// replacement needs to scan in, or its display name legitimately changed
// and the owner needs the new one accepted. Deliberately narrower than the
// owner-or-admin check the rest of this router uses: letting the owner
// self-serve this would let whoever controls that login also clear its own
// lock.
//
// Clearing locked_line_mid alone is not enough: as long as the bot's
// stored LINE session token is still valid, its next "start" resumes that
// same old account via resumeWithStoredToken (session-manager.ts) without
// ever presenting a fresh QR, and immediately re-locks right back to it.
// The stored token must go too — which means logging that session off
// first if it is still running, so nothing is using the account this
// action is meant to release. resetBotLockedLineMid() clears the locked
// display name alongside the account, so the very next login re-baselines
// both — the one button covers both "different account" and "same account,
// renamed" recoveries.
botDetailRoute.post("/reset-id-lock", requireAdmin, async (c) => {
	const botId = botIdOf(c);
	const bot = getBot(botId);
	if (!bot) return c.json({ error: "bot not found" }, 404);
	if (bot.status !== "offline") {
		try {
			stopBot(botId);
		} catch (error) {
			if (error instanceof WorkerScopeError) return c.json({ error: error.message }, 409);
			throw error;
		}
	}
	await clearStoredAuthToken(botId);
	resetBotLockedLineMid(botId);
	logUserAction(requestUser(c)!, "bot.reset_id_lock", { botId, botName: bot.name });
	return c.json({ ok: true });
});

// Admin-only: forces a bot to present a fresh LINE QR on its next start
// *without* releasing its one-LINE-account lock. An ordinary "หยุด" (stop)
// leaves the stored session token in place, so the next "start" resumes it
// silently via resumeWithStoredToken — no QR ever shows, which reads as
// "the old bot is still running" to whoever stopped it expecting to scan
// something new. This route clears just the token, same as /reset-id-lock,
// but deliberately skips resetBotLockedLineMid: the next login must still
// come from the same locked_line_mid *and* the same locked display name, or
// it is rejected and alerted like any other id_lock_mismatch/name_mismatch.
// Use /reset-id-lock instead when the intent is to actually hand the slot
// to a different LINE account, or to accept a display name that
// legitimately changed.
botDetailRoute.post("/force-relogin", requireAdmin, async (c) => {
	const botId = botIdOf(c);
	const bot = getBot(botId);
	if (!bot) return c.json({ error: "bot not found" }, 404);
	if (bot.status !== "offline") {
		try {
			stopBot(botId);
		} catch (error) {
			if (error instanceof WorkerScopeError) return c.json({ error: error.message }, 409);
			throw error;
		}
	}
	await clearStoredAuthToken(botId);
	logUserAction(requestUser(c)!, "bot.force_relogin", { botId, botName: bot.name });
	return c.json({ ok: true });
});

botDetailRoute.get("/chats", (c) => c.json(chatsStmt.all(botIdOf(c))));

// Re-syncs the chat list from a running bot's live LINE session right now,
// instead of waiting for the next reconnect — mainly for a newly-added OA
// friend, which otherwise doesn't appear until the bot restarts.
botDetailRoute.post("/chats/resync", async (c) => {
	const botId = botIdOf(c);
	const resynced = await resyncChatsNow(botId);
	if (!resynced) return c.json({ error: "bot ต้องออนไลน์ก่อนถึง sync รายการแชทได้" }, 409);
	logUserAction(requestUser(c)!, "chat.resync", { botId });
	return c.json({ ok: true, chats: chatsStmt.all(botId) });
});

const chatEnabledBodySchema = z.object({ enabled: z.boolean() });

botDetailRoute.patch("/chats/:mid", async (c) => {
	const result = chatEnabledBodySchema.safeParse(await c.req.json().catch(() => undefined));
	if (!result.success) return c.json({ error: formatZodError(result.error) }, 400);
	const botId = botIdOf(c);
	const mid = c.req.param("mid");
	const outcome = setChatEnabled(botId, mid, result.data.enabled);
	if (outcome === "not_found") return c.json({ error: "chat not found" }, 404);
	if (outcome === "room_limit") {
		return c.json({ error: `a bot may only fast-poll ${MAX_SQUARE_CHATS_PER_BOT} OpenChats at once — disable one first` }, 409);
	}
	// An enabled OpenChat should gain (or lose) its per-room low-latency
	// listener immediately; restarting the bot must not be required.
	syncFastSquarePollers(botId);
	logUserAction(requestUser(c)!, "chat.toggle_enabled", { botId, mid, enabled: result.data.enabled });
	return c.json({ ok: true });
});

const chatAdminOnlyBodySchema = z.object({ adminOnly: z.boolean() });

botDetailRoute.patch("/chats/:mid/admin-only", async (c) => {
	const result = chatAdminOnlyBodySchema.safeParse(await c.req.json().catch(() => undefined));
	if (!result.success) return c.json({ error: formatZodError(result.error) }, 400);
	const botId = botIdOf(c);
	const mid = c.req.param("mid");
	const chat = chatByMidStmt.get(botId, mid);
	if (!chat) return c.json({ error: "chat not found" }, 404);
	// OpenChat-only: LINE's classic group protocol has no admin role to check
	// a "talk" sender against, so the switch would be silently meaningless there.
	if (chat.surface !== "square") return c.json({ error: "admin-only ใช้ได้เฉพาะ OpenChat" }, 400);
	setChatAdminOnly(botId, mid, result.data.adminOnly);
	logUserAction(requestUser(c)!, "chat.toggle_admin_only", { botId, mid, adminOnly: result.data.adminOnly });
	return c.json({ ok: true });
});

botDetailRoute.get("/chats/:mid/room-bots", (c) => {
	const botId = botIdOf(c);
	const mid = c.req.param("mid");
	const chat = chatByMidStmt.get(botId, mid);
	if (!chat) return c.json({ error: "chat not found" }, 404);
	return c.json(
		roomBotsFor(botId, mid).map((bot) => ({
			...bot,
			name: getBot(bot.botId)?.name ?? null,
			slot: getBot(bot.botId)?.slot ?? null,
		})),
	);
});

botDetailRoute.patch("/chats/:mid/primary", (c) => {
	const botId = botIdOf(c);
	const mid = c.req.param("mid");
	const chat = chatByMidStmt.get(botId, mid);
	if (!chat) return c.json({ error: "chat not found" }, 404);
	if (chat.surface !== "square") return c.json({ error: "บอทหลักใช้ได้เฉพาะ OpenChat" }, 400);
	if (!setPrimaryBot(botId, mid)) {
		return c.json({ error: "บอทนี้ยังไม่ได้เปิดใช้งานในห้องนี้" }, 400);
	}
	logUserAction(requestUser(c)!, "chat.set_primary_bot", { botId, mid });
	return c.json({ ok: true });
});

const copyConfigBodySchema = z.object({ fromBotId: z.number().int().positive() });

botDetailRoute.post("/chats/:mid/copy-config", async (c) => {
	const result = copyConfigBodySchema.safeParse(await c.req.json().catch(() => undefined));
	if (!result.success) return c.json({ error: formatZodError(result.error) }, 400);
	const botId = botIdOf(c);
	const mid = c.req.param("mid");
	if (!canAccessBot(requestUser(c)!, result.data.fromBotId)) return c.json({ error: "forbidden" }, 403);
	const copied = copyRoomConfig(result.data.fromBotId, botId, mid);
	if (!copied) return c.json({ error: "ต้องเป็นบอทของเจ้าของเดียวกันทั้งสองตัว" }, 400);
	logUserAction(requestUser(c)!, "chat.copy_config", { botId, mid, fromBotId: result.data.fromBotId, ...copied });
	return c.json(copied);
});

botDetailRoute.get("/chats/:mid/members", (c) => {
	const botId = botIdOf(c);
	const mid = c.req.param("mid");
	const chat = chatByMidStmt.get(botId, mid);
	if (!chat) return c.json({ error: "chat not found" }, 404);
	if (chat.surface !== "square") return c.json({ error: "member roles ใช้ได้เฉพาะ OpenChat" }, 400);
	return c.json(listSquareMembers(botId, mid));
});

botDetailRoute.get("/chats/:mid/admin-allowlist", (c) => {
	const botId = botIdOf(c);
	const mid = c.req.param("mid");
	const chat = chatByMidStmt.get(botId, mid);
	if (!chat) return c.json({ error: "chat not found" }, 404);
	// An empty list is "any admin", not "no admin" — see chat-access.ts.
	// `rolesResolved` tells the UI apart from that: the member cache only
	// exists while the bot is connected, so an offline bot has no names to
	// choose from and the page must say so rather than render an empty box.
	return c.json({
		memberMids: listChatAdminAllowlist(botId, mid),
		rolesResolved: listSquareMembers(botId, mid).length > 0,
	});
});

const adminAllowlistBodySchema = z.object({
	memberMids: z.array(z.string().min(1).max(100)).max(100),
});

botDetailRoute.put("/chats/:mid/admin-allowlist", async (c) => {
	const result = adminAllowlistBodySchema.safeParse(await c.req.json().catch(() => undefined));
	if (!result.success) return c.json({ error: formatZodError(result.error) }, 400);
	const botId = botIdOf(c);
	const mid = c.req.param("mid");
	const chat = chatByMidStmt.get(botId, mid);
	if (!chat) return c.json({ error: "chat not found" }, 404);
	if (chat.surface !== "square") return c.json({ error: "admin-only ใช้ได้เฉพาะ OpenChat" }, 400);

	// Only members LINE currently reports as ADMIN/CO_ADMIN can be chosen.
	// Without this the list could be filled with mids that will never match,
	// which reads on the dashboard exactly like a working configuration and
	// behaves like a room that answers nobody.
	const admins = new Set(
		listSquareMembers(botId, mid)
			.filter((member) => isAdminRole(member.role))
			.map((member) => member.mid),
	);
	const unknown = result.data.memberMids.filter((memberMid) => !admins.has(memberMid));
	if (unknown.length > 0) {
		return c.json({ error: `เลือกได้เฉพาะ admin/co-admin ที่อยู่ในห้องนี้ (${unknown.length} รายการไม่ถูกต้อง)` }, 400);
	}

	setChatAdminAllowlist(botId, mid, result.data.memberMids);
	logUserAction(requestUser(c)!, "chat.set_admin_allowlist", { botId, mid, count: result.data.memberMids.length });
	return c.json({ ok: true, memberMids: result.data.memberMids });
});

botDetailRoute.get("/rules", (c) => c.json(listRules(botIdOf(c))));

// Shape-only schema — the detailed business rules (length limits, regex
// safety, etc.) already live in `bot/rules.ts`'s `validateRuleInput` /
// `RuleValidationError`, kept as the single source of truth for those.
// This just rejects malformed bodies before they reach that layer.
const ruleBodySchema = z.object({
	surface: z.enum(["talk", "square", "oa", "all"]),
	matchType: z.enum(["equals", "startsWith", "regex", "containsAny"]),
	matchValue: z.string(),
	replyText: z.string(),
	enabled: z.boolean(),
	priority: z.number().int(),
});

botDetailRoute.post("/rules", async (c) => {
	const botId = botIdOf(c);
	const result = ruleBodySchema.safeParse(await c.req.json().catch(() => undefined));
	if (!result.success) return c.json({ error: formatZodError(result.error) }, 400);
	try {
		const rule = createRule(botId, result.data as RuleInput);
		await prewarmReplyText(botId, rule.replyText);
		logUserAction(requestUser(c)!, "rule.create", { botId, ruleId: rule.id, matchValue: rule.matchValue });
		return c.json(rule, 201);
	} catch (error) {
		if (error instanceof RuleValidationError) return c.json({ error: error.message }, 400);
		throw error;
	}
});

botDetailRoute.put("/rules/:id", async (c) => {
	const botId = botIdOf(c);
	const id = ruleIdOf(c);
	if (id === undefined) return c.json({ error: "invalid rule id" }, 400);
	const result = ruleBodySchema.safeParse(await c.req.json().catch(() => undefined));
	if (!result.success) return c.json({ error: formatZodError(result.error) }, 400);
	try {
		if (!updateRule(botId, id, result.data as RuleInput)) {
			return c.json({ error: "rule not found" }, 404);
		}
		await prewarmReplyText(botId, result.data.replyText);
		logUserAction(requestUser(c)!, "rule.update", { botId, ruleId: id });
		return c.json({ ok: true });
	} catch (error) {
		if (error instanceof RuleValidationError) return c.json({ error: error.message }, 400);
		throw error;
	}
});

botDetailRoute.delete("/rules/:id", (c) => {
	const botId = botIdOf(c);
	const id = ruleIdOf(c);
	if (id === undefined) return c.json({ error: "invalid rule id" }, 400);
	if (!deleteRule(botId, id)) return c.json({ error: "rule not found" }, 404);
	logUserAction(requestUser(c)!, "rule.delete", { botId, ruleId: id });
	return c.json({ ok: true });
});

botDetailRoute.get("/scheduled-posts", (c) => c.json(listScheduledPosts(botIdOf(c))));

// Shape-only schema — the detailed business rules (targetMid format per
// surface, text length, runAt must be in the future) already live in
// `bot/scheduled-posts.ts`'s `assertScheduledPostInput`, kept as the single
// source of truth for those. runAt is epoch ms, already resolved from
// Bangkok wall time by the caller — this route does no timezone math.
const scheduledPostBodySchema = z.object({
	surface: z.enum(["talk", "square", "oa"] as const satisfies readonly Surface[]),
	targetMid: z.string(),
	text: z.string(),
	runAt: z.number().int(),
	enabled: z.boolean(),
});

botDetailRoute.post("/scheduled-posts", async (c) => {
	const botId = botIdOf(c);
	const result = scheduledPostBodySchema.safeParse(await c.req.json().catch(() => undefined));
	if (!result.success) return c.json({ error: formatZodError(result.error) }, 400);
	try {
		const post = createScheduledPost(botId, result.data as ScheduledPostInput);
		syncScheduledPostTimer(botId, post.id);
		logUserAction(requestUser(c)!, "scheduled_post.create", { botId, postId: post.id, runAt: post.runAt });
		return c.json(post, 201);
	} catch (error) {
		if (error instanceof ScheduledPostValidationError) return c.json({ error: error.message }, 400);
		throw error;
	}
});

botDetailRoute.put("/scheduled-posts/:id", async (c) => {
	const botId = botIdOf(c);
	const id = ruleIdOf(c);
	if (id === undefined) return c.json({ error: "invalid scheduled post id" }, 400);
	const result = scheduledPostBodySchema.safeParse(await c.req.json().catch(() => undefined));
	if (!result.success) return c.json({ error: formatZodError(result.error) }, 400);
	try {
		if (!updateScheduledPost(botId, id, result.data as ScheduledPostInput)) {
			return c.json({ error: "scheduled post not found" }, 404);
		}
		syncScheduledPostTimer(botId, id);
		logUserAction(requestUser(c)!, "scheduled_post.update", { botId, postId: id, runAt: result.data.runAt });
		return c.json({ ok: true });
	} catch (error) {
		if (error instanceof ScheduledPostValidationError) return c.json({ error: error.message }, 400);
		throw error;
	}
});

botDetailRoute.delete("/scheduled-posts/:id", (c) => {
	const botId = botIdOf(c);
	const id = ruleIdOf(c);
	if (id === undefined) return c.json({ error: "invalid scheduled post id" }, 400);
	if (!deleteScheduledPost(botId, id)) return c.json({ error: "scheduled post not found" }, 404);
	disarmScheduledPostTimer(id);
	logUserAction(requestUser(c)!, "scheduled_post.delete", { botId, postId: id });
	return c.json({ ok: true });
});

const testSendBodySchema = z.object({
	surface: z.enum(["talk", "square", "oa"] as const satisfies readonly Surface[]),
	targetMid: z.string().min(1),
	text: z.string().min(1),
});

botDetailRoute.post("/test-send", async (c) => {
	const botId = botIdOf(c);
	const result = testSendBodySchema.safeParse(await c.req.json().catch(() => undefined));
	if (!result.success) return c.json({ ok: false, error: "surface, targetMid, and text are required" }, 400);
	const { surface, targetMid, text } = result.data;
	const validTarget = surface === "square" ? /^m[0-9a-f]{32}$/i.test(targetMid) : /^[urc][0-9a-f]{32}$/i.test(targetMid);
	if (!validTarget) return c.json({ ok: false, error: "targetMid is invalid for surface" }, 400);
	try {
		await testSend(botId, surface, targetMid, text);
		return c.json({ ok: true });
	} catch (err) {
		return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
	}
});

function parseDateBound(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

const eventsStmt = db.prepare<BotEventRow, [number, number, number, number]>(
	"SELECT * FROM bot_events WHERE bot_id = ? AND ts >= ? AND ts <= ? ORDER BY id DESC LIMIT ?",
);

botDetailRoute.get("/events", (c) => {
	const botId = botIdOf(c);
	const limit = parseLimit(c.req.query("limit"), 200, 2000);
	const from = parseDateBound(c.req.query("from")) ?? 0;
	const to = parseDateBound(c.req.query("to")) ?? Date.now();
	// Newest first, top to bottom — matches every other tab on the admin
	// logs page. The DESC query above already returns that order.
	return c.json(eventsStmt.all(botId, from, to, limit));
});

const feedInStmt = db.prepare<MessageInRow, [number, number]>("SELECT * FROM messages_in WHERE bot_id = ? ORDER BY id DESC LIMIT ?");
const feedOutStmt = db.prepare<LatencySampleRow, [number, number]>(
	"SELECT * FROM latency_samples WHERE bot_id = ? ORDER BY id DESC LIMIT ?",
);

/**
 * Replays the live feed for a bot so the panel is populated on load.
 *
 * The two halves live in separate tables (incoming in `messages_in`, replies
 * in `latency_samples`) because they are written by different paths; they are
 * only a single timeline from the dashboard's point of view, so the merge
 * happens here rather than pushing two lists at the client.
 *
 * Each side is taken newest-first and capped at `limit` *before* merging, so
 * a bot that only ever receives cannot starve the query, and the result is
 * then trimmed to `limit` again and returned oldest-first — the order the
 * feed appends live events in.
 */
botDetailRoute.get("/feed", (c) => {
	const botId = botIdOf(c);
	const limit = parseLimit(c.req.query("limit"), 200, 1000);
	const items = [
		...feedInStmt.all(botId, limit).map((row) => ({
			kind: "in" as const,
			id: `in-db-${row.id}`,
			data: {
				botId: row.bot_id,
				ts: row.ts,
				surface: row.surface,
				targetMid: row.target_mid,
				text: row.text ?? "",
				createdTime: row.created_time ?? undefined,
			},
		})),
		...feedOutStmt.all(botId, limit).map((row) => ({
			kind: "out" as const,
			id: `out-db-${row.id}`,
			data: {
				botId: row.bot_id,
				ts: row.ts,
				surface: row.surface,
				targetMid: row.target_mid,
				latencyMs: row.latency_ms,
				ok: row.ok === 1,
				source: row.source,
				textPreview: row.text_preview ?? "",
			},
		})),
	];
	items.sort((a, b) => a.data.ts - b.data.ts);
	return c.json(items.slice(-limit));
});
