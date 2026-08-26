import { beforeEach, describe, expect, test } from "bun:test";

const { createAnnouncement, deleteAnnouncement, getAnnouncement, listAnnouncements, updateAnnouncement, AnnouncementValidationError } =
	await import("./announcements.ts");
const { db } = await import("../db/sqlite.ts");

beforeEach(() => {
	db.exec("DELETE FROM announcements");
});

describe("createAnnouncement validation", () => {
	test("accepts a valid title and body", () => {
		const created = createAnnouncement({ title: "ปิดปรับปรุงระบบ", body: "ระบบจะปิดปรับปรุง 23:00-00:00", isModalAlert: false }, 1);
		expect(created.title).toBe("ปิดปรับปรุงระบบ");
		expect(created.body).toBe("ระบบจะปิดปรับปรุง 23:00-00:00");
		expect(created.createdByUserId).toBe(1);
		expect(created.isModalAlert).toBe(false);
	});

	test("trims whitespace from title and body", () => {
		const created = createAnnouncement({ title: "  หัวข้อ  ", body: "  เนื้อหา  ", isModalAlert: false }, null);
		expect(created.title).toBe("หัวข้อ");
		expect(created.body).toBe("เนื้อหา");
	});

	test("rejects an empty title", () => {
		expect(() => createAnnouncement({ title: "  ", body: "เนื้อหา", isModalAlert: false }, null)).toThrow(AnnouncementValidationError);
	});

	test("rejects an empty body", () => {
		expect(() => createAnnouncement({ title: "หัวข้อ", body: "", isModalAlert: false }, null)).toThrow(AnnouncementValidationError);
	});

	test("rejects an over-length title", () => {
		expect(() => createAnnouncement({ title: "a".repeat(201), body: "เนื้อหา", isModalAlert: false }, null)).toThrow(
			AnnouncementValidationError,
		);
	});
});

describe("createAnnouncement isModalAlert", () => {
	test("persists true when flagged as an important modal alert", () => {
		const created = createAnnouncement({ title: "หัวข้อ", body: "เนื้อหา", isModalAlert: true }, null);
		expect(created.isModalAlert).toBe(true);
		expect(getAnnouncement(created.id)?.isModalAlert).toBe(true);
	});

	test("defaults an ordinary announcement to false", () => {
		const created = createAnnouncement({ title: "หัวข้อ", body: "เนื้อหา", isModalAlert: false }, null);
		expect(created.isModalAlert).toBe(false);
	});
});

describe("listAnnouncements", () => {
	test("returns newest first", () => {
		const first = createAnnouncement({ title: "แรก", body: "1", isModalAlert: false }, null);
		const second = createAnnouncement({ title: "สอง", body: "2", isModalAlert: false }, null);
		const listed = listAnnouncements();
		expect(listed.map((a) => a.id)).toEqual([second.id, first.id]);
	});
});

describe("updateAnnouncement", () => {
	test("updates title and body, bumping updatedAt", async () => {
		const created = createAnnouncement({ title: "เดิม", body: "เดิม", isModalAlert: false }, null);
		await new Promise((resolve) => setTimeout(resolve, 2));
		const updated = updateAnnouncement(created.id, { title: "ใหม่", body: "ใหม่", isModalAlert: false });
		expect(updated?.title).toBe("ใหม่");
		expect(updated?.body).toBe("ใหม่");
		expect(updated!.updatedAt).toBeGreaterThan(created.updatedAt);
		expect(updated!.createdAt).toBe(created.createdAt);
	});

	test("can flip isModalAlert on an existing announcement", () => {
		const created = createAnnouncement({ title: "เดิม", body: "เดิม", isModalAlert: false }, null);
		const updated = updateAnnouncement(created.id, { title: "เดิม", body: "เดิม", isModalAlert: true });
		expect(updated?.isModalAlert).toBe(true);
	});

	test("returns undefined for a missing id", () => {
		expect(updateAnnouncement(999_999, { title: "x", body: "y", isModalAlert: false })).toBeUndefined();
	});
});

describe("deleteAnnouncement", () => {
	test("removes the row and reports success", () => {
		const created = createAnnouncement({ title: "ลบทิ้ง", body: "ลบทิ้ง", isModalAlert: false }, null);
		expect(deleteAnnouncement(created.id)).toBe(true);
		expect(getAnnouncement(created.id)).toBeUndefined();
	});

	test("reports false for a missing id", () => {
		expect(deleteAnnouncement(999_999)).toBe(false);
	});
});
