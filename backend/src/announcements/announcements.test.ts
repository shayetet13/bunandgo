import { beforeEach, describe, expect, test } from "bun:test";

const { createAnnouncement, deleteAnnouncement, getAnnouncement, listAnnouncements, updateAnnouncement, AnnouncementValidationError } =
	await import("./announcements.ts");
const { db } = await import("../db/sqlite.ts");

beforeEach(() => {
	db.exec("DELETE FROM announcements");
});

const base = { isModalAlert: false, isPinned: false };

describe("createAnnouncement validation", () => {
	test("accepts a valid title and body", () => {
		const created = createAnnouncement({ title: "ปิดปรับปรุงระบบ", body: "ระบบจะปิดปรับปรุง 23:00-00:00", ...base }, 1);
		expect(created.title).toBe("ปิดปรับปรุงระบบ");
		expect(created.body).toBe("ระบบจะปิดปรับปรุง 23:00-00:00");
		expect(created.createdByUserId).toBe(1);
		expect(created.isModalAlert).toBe(false);
		expect(created.isPinned).toBe(false);
	});

	test("trims whitespace from title and body", () => {
		const created = createAnnouncement({ title: "  หัวข้อ  ", body: "  เนื้อหา  ", ...base }, null);
		expect(created.title).toBe("หัวข้อ");
		expect(created.body).toBe("เนื้อหา");
	});

	test("rejects an empty title", () => {
		expect(() => createAnnouncement({ title: "  ", body: "เนื้อหา", ...base }, null)).toThrow(AnnouncementValidationError);
	});

	test("rejects an empty body", () => {
		expect(() => createAnnouncement({ title: "หัวข้อ", body: "", ...base }, null)).toThrow(AnnouncementValidationError);
	});

	test("rejects an over-length title", () => {
		expect(() => createAnnouncement({ title: "a".repeat(201), body: "เนื้อหา", ...base }, null)).toThrow(AnnouncementValidationError);
	});
});

describe("createAnnouncement isModalAlert", () => {
	test("persists true when flagged as an important modal alert", () => {
		const created = createAnnouncement({ title: "หัวข้อ", body: "เนื้อหา", ...base, isModalAlert: true }, null);
		expect(created.isModalAlert).toBe(true);
		expect(getAnnouncement(created.id)?.isModalAlert).toBe(true);
	});

	test("defaults an ordinary announcement to false", () => {
		const created = createAnnouncement({ title: "หัวข้อ", body: "เนื้อหา", ...base }, null);
		expect(created.isModalAlert).toBe(false);
	});
});

describe("createAnnouncement isPinned", () => {
	test("persists true when pinned", () => {
		const created = createAnnouncement({ title: "หัวข้อ", body: "เนื้อหา", ...base, isPinned: true }, null);
		expect(created.isPinned).toBe(true);
		expect(getAnnouncement(created.id)?.isPinned).toBe(true);
	});

	test("defaults an ordinary announcement to unpinned", () => {
		const created = createAnnouncement({ title: "หัวข้อ", body: "เนื้อหา", ...base }, null);
		expect(created.isPinned).toBe(false);
	});
});

describe("listAnnouncements", () => {
	test("returns newest first", () => {
		const first = createAnnouncement({ title: "แรก", body: "1", ...base }, null);
		const second = createAnnouncement({ title: "สอง", body: "2", ...base }, null);
		const listed = listAnnouncements();
		expect(listed.map((a) => a.id)).toEqual([second.id, first.id]);
	});

	test("a pinned announcement sorts before unpinned ones created later", () => {
		const firstUnpinned = createAnnouncement({ title: "ไม่ปักหมุด 1", body: "1", ...base }, null);
		const pinned = createAnnouncement({ title: "ปักหมุด", body: "2", ...base, isPinned: true }, null);
		const lastUnpinned = createAnnouncement({ title: "ไม่ปักหมุด 2", body: "3", ...base }, null);
		const listed = listAnnouncements();
		expect(listed.map((a) => a.id)).toEqual([pinned.id, lastUnpinned.id, firstUnpinned.id]);
	});

	test("multiple pinned announcements still sort newest-pinned first among themselves", () => {
		const firstPinned = createAnnouncement({ title: "ปักหมุด 1", body: "1", ...base, isPinned: true }, null);
		const secondPinned = createAnnouncement({ title: "ปักหมุด 2", body: "2", ...base, isPinned: true }, null);
		const listed = listAnnouncements();
		expect(listed.map((a) => a.id)).toEqual([secondPinned.id, firstPinned.id]);
	});
});

describe("updateAnnouncement", () => {
	test("updates title and body, bumping updatedAt", async () => {
		const created = createAnnouncement({ title: "เดิม", body: "เดิม", ...base }, null);
		await new Promise((resolve) => setTimeout(resolve, 2));
		const updated = updateAnnouncement(created.id, { title: "ใหม่", body: "ใหม่", ...base });
		expect(updated?.title).toBe("ใหม่");
		expect(updated?.body).toBe("ใหม่");
		expect(updated!.updatedAt).toBeGreaterThan(created.updatedAt);
		expect(updated!.createdAt).toBe(created.createdAt);
	});

	test("can flip isModalAlert on an existing announcement", () => {
		const created = createAnnouncement({ title: "เดิม", body: "เดิม", ...base }, null);
		const updated = updateAnnouncement(created.id, { title: "เดิม", body: "เดิม", ...base, isModalAlert: true });
		expect(updated?.isModalAlert).toBe(true);
	});

	test("can flip isPinned on an existing announcement", () => {
		const created = createAnnouncement({ title: "เดิม", body: "เดิม", ...base }, null);
		const updated = updateAnnouncement(created.id, { title: "เดิม", body: "เดิม", ...base, isPinned: true });
		expect(updated?.isPinned).toBe(true);
	});

	test("returns undefined for a missing id", () => {
		expect(updateAnnouncement(999_999, { title: "x", body: "y", ...base })).toBeUndefined();
	});
});

describe("deleteAnnouncement", () => {
	test("removes the row and reports success", () => {
		const created = createAnnouncement({ title: "ลบทิ้ง", body: "ลบทิ้ง", ...base }, null);
		expect(deleteAnnouncement(created.id)).toBe(true);
		expect(getAnnouncement(created.id)).toBeUndefined();
	});

	test("reports false for a missing id", () => {
		expect(deleteAnnouncement(999_999)).toBe(false);
	});
});
