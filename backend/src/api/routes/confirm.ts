import { Hono } from "hono";
import { acceptStartConfirmation, declineStartConfirmation, getStartConfirmation } from "../../bot/start-confirmation.ts";
import { getBot } from "../../bot/bots.ts";

/**
 * Deliberately unauthenticated — opened by scanning a QR from a device that
 * has no dashboard session at all. The random token is the only credential;
 * see start-confirmation.ts for its lifetime/single-use guarantees.
 */
export const confirmRoute = new Hono();

confirmRoute.get("/:token", (c) => {
	const confirmation = getStartConfirmation(c.req.param("token"));
	if (!confirmation) return c.json({ error: "ลิงก์นี้ไม่ถูกต้องหรือหมดอายุแล้ว" }, 404);
	const bot = getBot(confirmation.botId);
	return c.json({ status: confirmation.status, botName: bot?.name ?? null });
});

confirmRoute.post("/:token/accept", async (c) => {
	const ok = await acceptStartConfirmation(c.req.param("token"));
	if (!ok) return c.json({ error: "ลิงก์นี้ไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว" }, 404);
	return c.json({ ok: true });
});

confirmRoute.post("/:token/decline", (c) => {
	const ok = declineStartConfirmation(c.req.param("token"));
	if (!ok) return c.json({ error: "ลิงก์นี้ไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว" }, 404);
	return c.json({ ok: true });
});
