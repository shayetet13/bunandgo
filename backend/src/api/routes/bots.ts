import { Hono } from "hono";
import { z } from "zod";
import { createBot, listBotsForUser, oldestBotOwnedBy, reorderBotsForUser } from "../../bot/bots.ts";
import { requestUser } from "../../auth/request-user.ts";
import { logUserAction } from "../../auth/user-actions.ts";
import { BOT_PRICE_THB_PER_MONTH, MAX_BOT_QUOTA } from "../../auth/users.ts";
import type { Device } from "../../linejs-core/base/mod.ts";
import { copyRules } from "../../bot/room-config-copy.ts";
import { formatZodError } from "../validate.ts";
import { isControlPlane } from "../../bot/worker-topology.ts";
import { WorkerScopeError } from "../../bot/worker-scope.ts";

export const botsRoute = new Hono();

botsRoute.get("/", (c) => c.json(listBotsForUser(requestUser(c)!, { includeAllWorkers: isControlPlane() })));

const reorderBotsBodySchema = z.object({
	botIds: z.array(z.number().int().positive()).max(1_000),
});

botsRoute.put("/order", async (c) => {
	const result = reorderBotsBodySchema.safeParse(await c.req.json().catch(() => undefined));
	if (!result.success) return c.json({ error: formatZodError(result.error) }, 400);
	const user = requestUser(c)!;
	try {
		const bots = reorderBotsForUser(user, result.data.botIds);
		logUserAction(user, "bot.reorder", { botIds: result.data.botIds });
		return c.json(bots);
	} catch (error) {
		if (error instanceof WorkerScopeError) return c.json({ error: error.message }, 403);
		return c.json({ error: error instanceof Error ? error.message : "invalid bot order" }, 400);
	}
});

const SUPPORTED_DEVICES = [
	"DESKTOPWIN",
	"DESKTOPMAC",
	"ANDROID",
	"ANDROIDSECONDARY",
	"IOS",
	"IOSIPAD",
	"WATCHOS",
	"WEAROS",
] as const satisfies readonly Device[];

const createBotBodySchema = z.object({
	name: z.string().trim().min(1, "name is required").max(100, "name must not exceed 100 characters"),
	device: z.enum(SUPPORTED_DEVICES).optional(),
});

botsRoute.post("/", async (c) => {
	const result = createBotBodySchema.safeParse(await c.req.json().catch(() => undefined));
	if (!result.success) return c.json({ error: formatZodError(result.error) }, 400);

	const user = requestUser(c)!;
	// Admins are uncapped; everyone else is held to the quota an admin set
	// for them, which starts at one and is raised per user once they pay.
	if (user.role !== "admin" && listBotsForUser(user, { includeAllWorkers: true }).length >= user.botQuota) {
		return c.json(
			{
				error: `บอทของคุณเต็มโควตาแล้ว (${user.botQuota} ตัว) — ติดต่อผู้ดูแลระบบเพื่อเพิ่มบอท ค่าบริการ ${BOT_PRICE_THB_PER_MONTH} บาท/เดือน ต่อ 1 ตัว`,
				quota: user.botQuota,
				maxQuota: MAX_BOT_QUOTA,
				pricePerMonthThb: BOT_PRICE_THB_PER_MONTH,
			},
			403,
		);
	}
	// A new sibling starts as the newest bot for this owner, so the oldest
	// one found now is always some *other* bot — never the one just created.
	const sibling = oldestBotOwnedBy(user.id);
	const bot = createBot(result.data.name, result.data.device, user.id);
	logUserAction(user, "bot.create", { botId: bot.id, botName: bot.name, device: bot.device });

	const rulesCopiedFrom = sibling ? copyRules(sibling.id, bot.id) : undefined;
	if (rulesCopiedFrom && rulesCopiedFrom.rulesCopied > 0) {
		logUserAction(user, "bot.auto_copy_rules", { botId: bot.id, fromBotId: sibling!.id, ...rulesCopiedFrom });
	}

	return c.json({ ...bot, rulesCopiedFrom: rulesCopiedFrom?.rulesCopied ?? 0 }, 201);
});
