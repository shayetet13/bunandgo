import { beforeEach, describe, expect, test } from "bun:test";
import type { Announcement } from "./types.ts";

// bun:test runs without DOM globals — announcement-alert-dismissal.ts calls
// the real browser localStorage, so a minimal in-memory stand-in is enough
// to exercise it here without pulling in a DOM polyfill for one module.
class MemoryStorage {
	#store = new Map<string, string>();
	getItem(key: string): string | null {
		return this.#store.has(key) ? this.#store.get(key)! : null;
	}
	setItem(key: string, value: string): void {
		this.#store.set(key, value);
	}
	removeItem(key: string): void {
		this.#store.delete(key);
	}
	clear(): void {
		this.#store.clear();
	}
}
(globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();

const { dismissAnnouncementModalAlert, undismissedModalAlerts } = await import("./announcement-alert-dismissal.ts");

function announcement(id: number, isModalAlert: boolean): Announcement {
	return {
		id,
		title: `title-${id}`,
		body: `body-${id}`,
		createdByUserId: null,
		createdAt: id,
		updatedAt: id,
		isModalAlert,
		isPinned: false,
	};
}

beforeEach(() => {
	localStorage.clear();
});

describe("undismissedModalAlerts", () => {
	test("keeps only flagged announcements, in the order given", () => {
		const items = [announcement(1, true), announcement(2, false), announcement(3, true)];
		expect(undismissedModalAlerts(items).map((item) => item.id)).toEqual([1, 3]);
	});

	test("returns nothing when none are flagged", () => {
		expect(undismissedModalAlerts([announcement(1, false)])).toEqual([]);
	});
});

describe("dismissAnnouncementModalAlert", () => {
	test("removes a dismissed id from future calls", () => {
		const items = [announcement(1, true), announcement(2, true)];
		dismissAnnouncementModalAlert(1);
		expect(undismissedModalAlerts(items).map((item) => item.id)).toEqual([2]);
	});

	test("does not affect other ids", () => {
		dismissAnnouncementModalAlert(1);
		dismissAnnouncementModalAlert(2);
		expect(undismissedModalAlerts([announcement(3, true)]).map((item) => item.id)).toEqual([3]);
	});

	test("a fresh announcement with the same id as a previously deleted+recreated one stays hidden — accepted tradeoff, ids are never reused by SQLite AUTOINCREMENT", () => {
		dismissAnnouncementModalAlert(5);
		expect(undismissedModalAlerts([announcement(5, true)])).toEqual([]);
	});
});
