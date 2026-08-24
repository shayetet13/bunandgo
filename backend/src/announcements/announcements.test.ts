import { beforeEach, describe, expect, test } from "bun:test";

const { createAnnouncement, deleteAnnouncement, getAnnouncement, listAnnouncements, updateAnnouncement, AnnouncementValidationError } =
	await import("./announcements.ts");
const { db } = await import("../db/sqlite.ts");

beforeEach(() => {
	db.exec("DELETE FROM announcements");
});

describe("createAnnouncement validation", () => {
	test("accepts a valid title and body", () => {
		const created = createAnnouncement({ title: "ปิดปรับปรุงระบบ", body: "ระบบจะปิดปรับปรุง 23:00-00:00" }, 1);
		expect(created.title).toBe("ปิดปรับปรุงระบบ");
		expect(created.body).toBe("ระบบจะปิดปรับปรุง 23:00-00:00");
		expect(created.createdByUserId).toBe(1);
	});

	test("trims whitespace from title and body", () => {
		const created = createAnnouncement({ title: "  หัวข้อ  ", body: "  เนื้อหา  " }, null);
		expect(created.title).toBe("หัวข้อ");
		expect(created.body).toBe("เนื้อหา");
	});

	test("rejects an empty title", () => {
		expect(() => createAnnouncement({ title: "  ", body: "เนื้อหา" }, null)).toThrow(AnnouncementValidationError);
	});

	test("rejects an empty body", () => {
		expect(() => createAnnouncement({ title: "หัวข้อ", body: "" }, null)).toThrow(AnnouncementValidationError);
	});

	test("rejects an over-length title", () => {
		expect(() => createAnnouncement({ title: "a".repeat(201), body: "เนื้อหา" }, null)).toThrow(AnnouncementValidationError);
	});
});

describe("listAnnouncements", () => {
	test("returns newest first", () => {
		const first = createAnnouncement({ title: "แรก", body: "1" }, null);
		const second = createAnnouncement({ title: "สอง", body: "2" }, null);
		const listed = listAnnouncements();
		expect(listed.map((a) => a.id)).toEqual([second.id, first.id]);
	});
});

describe("updateAnnouncement", () => {
	test("updates title and body, bumping updatedAt", async () => {
		const created = createAnnouncement({ title: "เดิม", body: "เดิม" }, null);
		await new Promise((resolve) => setTimeout(resolve, 2));
		const updated = updateAnnouncement(created.id, { title: "ใหม่", body: "ใหม่" });
		expect(updated?.title).toBe("ใหม่");
		expect(updated?.body).toBe("ใหม่");
		expect(updated!.updatedAt).toBeGreaterThan(created.updatedAt);
		expect(updated!.createdAt).toBe(created.createdAt);
	});

	test("returns undefined for a missing id", () => {
		expect(updateAnnouncement(999_999, { title: "x", body: "y" })).toBeUndefined();
	});
});

describe("deleteAnnouncement", () => {
	test("removes the row and reports success", () => {
		const created = createAnnouncement({ title: "ลบทิ้ง", body: "ลบทิ้ง" }, null);
		expect(deleteAnnouncement(created.id)).toBe(true);
		expect(getAnnouncement(created.id)).toBeUndefined();
	});

	test("reports false for a missing id", () => {
		expect(deleteAnnouncement(999_999)).toBe(false);
	});
});
