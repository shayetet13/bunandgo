import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

const {
	createScheduledPost,
	deleteScheduledPost,
	disableScheduledPost,
	getScheduledPost,
	listAllPendingScheduledPosts,
	listScheduledPosts,
	markScheduledPostSent,
	ScheduledPostValidationError,
	updateScheduledPost,
} = await import("./scheduled-posts.ts");
const { db } = await import("../db/sqlite.ts");

const BOT = 1;
const OTHER_BOT = 2;
const VALID_TALK_MID = `u${"a".repeat(32)}`;
const VALID_SQUARE_MID = `m${"b".repeat(32)}`;
const FUTURE = Date.now() + 60_000;

const baseInput = {
	surface: "talk" as const,
	targetMid: VALID_TALK_MID,
	text: "แย่งให้ได้ที่ 1",
	runAt: FUTURE,
	enabled: true,
};

beforeAll(() => {
	db.exec("DELETE FROM bots; DELETE FROM scheduled_posts;");
});

beforeEach(() => {
	db.exec("DELETE FROM scheduled_posts");
});

describe("createScheduledPost validation", () => {
	test("accepts a valid talk post", () => {
		const post = createScheduledPost(BOT, baseInput);
		expect(post.id).toBeGreaterThan(0);
		expect(post.sentAt).toBeNull();
		expect(post.enabled).toBe(true);
	});

	test("accepts a valid square post", () => {
		const post = createScheduledPost(BOT, { ...baseInput, surface: "square", targetMid: VALID_SQUARE_MID });
		expect(post.surface).toBe("square");
	});

	test("rejects a talk mid on a square post and vice versa", () => {
		expect(() => createScheduledPost(BOT, { ...baseInput, surface: "square", targetMid: VALID_TALK_MID })).toThrow(
			ScheduledPostValidationError,
		);
		expect(() => createScheduledPost(BOT, { ...baseInput, targetMid: VALID_SQUARE_MID })).toThrow(ScheduledPostValidationError);
	});

	test("rejects empty text", () => {
		expect(() => createScheduledPost(BOT, { ...baseInput, text: "   " })).toThrow("text is required");
	});

	test("rejects a run time in the past", () => {
		expect(() => createScheduledPost(BOT, { ...baseInput, runAt: Date.now() - 60_000 })).toThrow("runAt must be in the future");
	});

	test("allows a run time within the small clock-skew grace window", () => {
		expect(() => createScheduledPost(BOT, { ...baseInput, runAt: Date.now() - 500 })).not.toThrow();
	});
});

describe("scheduled post lifecycle", () => {
	test("lists posts scoped to their bot", () => {
		createScheduledPost(BOT, baseInput);
		createScheduledPost(OTHER_BOT, baseInput);

		expect(listScheduledPosts(BOT)).toHaveLength(1);
		expect(listScheduledPosts(OTHER_BOT)).toHaveLength(1);
	});

	test("update resets sentAt so an edited post can run again", () => {
		const post = createScheduledPost(BOT, baseInput);
		markScheduledPostSent(post.id, Date.now());
		expect(getScheduledPost(BOT, post.id)?.sentAt).not.toBeNull();

		updateScheduledPost(BOT, post.id, { ...baseInput, text: "รอบใหม่" });

		const updated = getScheduledPost(BOT, post.id);
		expect(updated?.sentAt).toBeNull();
		expect(updated?.text).toBe("รอบใหม่");
	});

	test("reports missing updates and deletes", () => {
		expect(updateScheduledPost(BOT, 999_999, baseInput)).toBe(false);
		expect(deleteScheduledPost(BOT, 999_999)).toBe(false);
	});

	test("delete removes the row", () => {
		const post = createScheduledPost(BOT, baseInput);
		expect(deleteScheduledPost(BOT, post.id)).toBe(true);
		expect(getScheduledPost(BOT, post.id)).toBeUndefined();
	});

	test("disableScheduledPost stops it from being listed as pending", () => {
		const post = createScheduledPost(BOT, baseInput);
		expect(listAllPendingScheduledPosts().some((p) => p.id === post.id)).toBe(true);

		disableScheduledPost(post.id);

		expect(listAllPendingScheduledPosts().some((p) => p.id === post.id)).toBe(false);
	});

	test("a sent post is no longer pending", () => {
		const post = createScheduledPost(BOT, baseInput);

		markScheduledPostSent(post.id, Date.now());

		expect(listAllPendingScheduledPosts().some((p) => p.id === post.id)).toBe(false);
	});
});
