import { Hono } from "hono";
import { z } from "zod";
import { formatZodError } from "../validate.ts";
import { requestUser, requireAdmin } from "../../auth/request-user.ts";
import {
	AnnouncementValidationError,
	createAnnouncement,
	deleteAnnouncement,
	listAnnouncements,
	updateAnnouncement,
} from "../../announcements/announcements.ts";
import { logUserAction } from "../../auth/user-actions.ts";

export const announcementsRoute = new Hono();

// Every signed-in user reads the same list — this is what UserConsole
// renders in place of the old race-commentary card, and what the admin
// dashboard's own announcements page lists to manage.
announcementsRoute.get("/", (c) => c.json(listAnnouncements()));

const announcementBodySchema = z.object({ title: z.string(), body: z.string() });

announcementsRoute.post("/", requireAdmin, async (c) => {
	const result = announcementBodySchema.safeParse(await c.req.json().catch(() => undefined));
	if (!result.success) return c.json({ error: formatZodError(result.error) }, 400);
	try {
		const user = requestUser(c)!;
		const created = createAnnouncement(result.data, user.id);
		logUserAction(user, "announcement.create", { announcementId: created.id, title: created.title });
		return c.json(created, 201);
	} catch (error) {
		if (error instanceof AnnouncementValidationError) return c.json({ error: error.message }, 400);
		throw error;
	}
});

announcementsRoute.put("/:id", requireAdmin, async (c) => {
	const id = Number(c.req.param("id"));
	const result = announcementBodySchema.safeParse(await c.req.json().catch(() => undefined));
	if (!Number.isInteger(id) || id <= 0 || !result.success) {
		return c.json({ error: result.success ? "invalid announcement id" : formatZodError(result.error) }, 400);
	}
	try {
		const updated = updateAnnouncement(id, result.data);
		if (!updated) return c.json({ error: "announcement not found" }, 404);
		logUserAction(requestUser(c)!, "announcement.update", { announcementId: id, title: updated.title });
		return c.json(updated);
	} catch (error) {
		if (error instanceof AnnouncementValidationError) return c.json({ error: error.message }, 400);
		throw error;
	}
});

announcementsRoute.delete("/:id", requireAdmin, (c) => {
	const id = Number(c.req.param("id"));
	if (!Number.isInteger(id) || id <= 0) return c.json({ error: "invalid announcement id" }, 400);
	if (!deleteAnnouncement(id)) return c.json({ error: "announcement not found" }, 404);
	logUserAction(requestUser(c)!, "announcement.delete", { announcementId: id });
	return c.json({ ok: true });
});
