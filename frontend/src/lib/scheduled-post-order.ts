import type { ScheduledPost } from "./types.ts";

/** User-console order: latest scheduled time first, then latest-created id. */
export function newestScheduledPostsFirst(posts: readonly ScheduledPost[]): ScheduledPost[] {
	return [...posts].sort((a, b) => b.runAt - a.runAt || b.id - a.id);
}
