import type { ScheduledPost } from "./types.ts";

/**
 * Where a scheduled post is in its one-shot lifecycle. Shared between the
 * admin editor and the user console so "พลาดเวลา" vs "ปิดใช้งาน" vs
 * "กำลังจะโพส…" mean the same thing in both places.
 */
export type ScheduledPostStatus = "sent" | "missed" | "disabledByUser" | "processing" | "pending";

export function scheduledPostStatusOf(post: ScheduledPost): ScheduledPostStatus {
	if (post.sentAt !== null) return "sent";
	if (!post.enabled) return post.runAt < Date.now() ? "missed" : "disabledByUser";
	if (post.runAt < Date.now()) return "processing";
	return "pending";
}

export const SCHEDULED_POST_STATUS_LABEL: Record<ScheduledPostStatus, string> = {
	sent: "ส่งแล้ว",
	missed: "พลาดเวลา",
	disabledByUser: "ปิดใช้งาน",
	processing: "กำลังจะโพส…",
	pending: "รอเวลา",
};

/** Whether this post can still be turned on/off — false once it has fired or is about to. */
export function isScheduledPostToggleable(status: ScheduledPostStatus): boolean {
	return status === "pending" || status === "disabledByUser";
}

/**
 * Same grace window as the backend's `PAST_GRACE_MS`
 * (backend/src/bot/scheduled-posts.ts) — kept numerically in sync by hand
 * since there's no shared package between the two, but both need to agree:
 * a submit right at "now" (client clock a hair behind the server's, or a
 * slow submit) should not be accepted by one side and rejected by the
 * other. Previously the two admin/user-console copies of this check had no
 * grace at all while the backend allowed 2s, so a submit in that window
 * could be rejected client-side for a time the server would have accepted.
 */
const RUN_AT_PAST_GRACE_MS = 2_000;

/** Whether a candidate runAt (epoch ms) is far enough in the future to submit. */
export function isScheduledPostRunAtValid(runAt: number): boolean {
	return runAt >= Date.now() - RUN_AT_PAST_GRACE_MS;
}
