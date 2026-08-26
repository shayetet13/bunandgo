import type { Announcement } from "./types.ts";

const STORAGE_KEY = "announcement-modal-dismissed-ids";

/** Per-browser only — a fresh device/profile sees a still-active modal alert again, which is intended. */
function readDismissedIds(): Set<number> {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return new Set();
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? new Set(parsed.filter((id): id is number => typeof id === "number")) : new Set();
	} catch {
		return new Set();
	}
}

export function dismissAnnouncementModalAlert(id: number): void {
	try {
		const ids = readDismissedIds();
		ids.add(id);
		localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
	} catch {
		// Storage unavailable (private browsing, quota) — the modal just
		// reappears next load, which is the safe direction to fail in.
	}
}

/** Newest-first order preserved — callers pass `listAnnouncements()`'s own order straight through. */
export function undismissedModalAlerts(announcements: readonly Announcement[]): Announcement[] {
	const dismissed = readDismissedIds();
	return announcements.filter((item) => item.isModalAlert && !dismissed.has(item.id));
}
