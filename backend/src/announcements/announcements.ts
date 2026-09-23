import { db } from "../db/sqlite.ts";
import type { AnnouncementRow } from "../db/schema.ts";

/**
 * A short admin-authored notice shown on every signed-in user's console —
 * the replacement for the old "ผู้บรรยายสนาม" race-commentary card. Not
 * bot- or owner-scoped: one shared list, same as an app_meta setting,
 * visible from every worker process.
 */
export interface Announcement {
	id: number;
	title: string;
	body: string;
	createdByUserId: number | null;
	createdAt: number;
	updatedAt: number;
	/**
	 * Also shown as a center-screen modal (with carousel paging if more than
	 * one is flagged) rather than only the inline notice card — reserved for
	 * news a user must not be able to miss. See AnnouncementAlertModal.tsx.
	 */
	isModalAlert: boolean;
	/** Pinned announcements sort before every unpinned one, newest-pinned first — see listStmt's ORDER BY. */
	isPinned: boolean;
}

function fromRow(row: AnnouncementRow): Announcement {
	return {
		id: row.id,
		title: row.title,
		body: row.body,
		createdByUserId: row.created_by_user_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		isModalAlert: row.is_modal_alert === 1,
		isPinned: row.is_pinned === 1,
	};
}

const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 4000;

export class AnnouncementValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AnnouncementValidationError";
	}
}

export interface AnnouncementInput {
	title: string;
	body: string;
	isModalAlert: boolean;
	isPinned: boolean;
}

function assertAnnouncementInput(input: AnnouncementInput): void {
	if (!input || typeof input.title !== "string" || !input.title.trim()) {
		throw new AnnouncementValidationError("title is required");
	}
	if (input.title.length > MAX_TITLE_LENGTH) {
		throw new AnnouncementValidationError(`title must not exceed ${MAX_TITLE_LENGTH} characters`);
	}
	if (typeof input.body !== "string" || !input.body.trim()) {
		throw new AnnouncementValidationError("body is required");
	}
	if (input.body.length > MAX_BODY_LENGTH) {
		throw new AnnouncementValidationError(`body must not exceed ${MAX_BODY_LENGTH} characters`);
	}
}

const listStmt = db.prepare<AnnouncementRow, []>("SELECT * FROM announcements ORDER BY is_pinned DESC, created_at DESC, id DESC");
const getStmt = db.prepare<AnnouncementRow, [number]>("SELECT * FROM announcements WHERE id = ?");
const insertStmt = db.prepare<AnnouncementRow, [string, string, number | null, number, number, number, number]>(
	"INSERT INTO announcements (title, body, created_by_user_id, created_at, updated_at, is_modal_alert, is_pinned) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *",
);
const updateStmt = db.prepare<null, [string, string, number, number, number, number]>(
	"UPDATE announcements SET title = ?, body = ?, updated_at = ?, is_modal_alert = ?, is_pinned = ? WHERE id = ?",
);
const deleteStmt = db.prepare<null, [number]>("DELETE FROM announcements WHERE id = ?");

/** Pinned first (newest-pinned first), then everything else newest first — what both the admin dashboard and every user's console render. */
export function listAnnouncements(): Announcement[] {
	return listStmt.all().map(fromRow);
}

export function getAnnouncement(id: number): Announcement | undefined {
	const row = getStmt.get(id);
	return row ? fromRow(row) : undefined;
}

export function createAnnouncement(input: AnnouncementInput, createdByUserId: number | null): Announcement {
	assertAnnouncementInput(input);
	const now = Date.now();
	const row = insertStmt.get(
		input.title.trim(),
		input.body.trim(),
		createdByUserId,
		now,
		now,
		input.isModalAlert ? 1 : 0,
		input.isPinned ? 1 : 0,
	);
	return fromRow(row!);
}

export function updateAnnouncement(id: number, input: AnnouncementInput): Announcement | undefined {
	assertAnnouncementInput(input);
	updateStmt.run(input.title.trim(), input.body.trim(), Date.now(), input.isModalAlert ? 1 : 0, input.isPinned ? 1 : 0, id);
	return getAnnouncement(id);
}

export function deleteAnnouncement(id: number): boolean {
	return deleteStmt.run(id).changes > 0;
}
