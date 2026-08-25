import { describe, expect, test } from "bun:test";
import type { ScheduledPost } from "./types.ts";
import { newestScheduledPostsFirst } from "./scheduled-post-order.ts";

function post(id: number, runAt: number): ScheduledPost {
	return {
		id,
		botId: 1,
		surface: "talk",
		targetMid: "u00000000000000000000000000000000",
		text: `post-${id}`,
		runAt,
		enabled: true,
		sentAt: null,
	};
}

describe("scheduled post ordering", () => {
	test("orders newest scheduled time first without mutating the API result", () => {
		const input = [post(1, 1_000), post(2, 3_000), post(3, 2_000)];

		expect(newestScheduledPostsFirst(input).map((item) => item.id)).toEqual([2, 3, 1]);
		expect(input.map((item) => item.id)).toEqual([1, 2, 3]);
	});

	test("uses the newest id first when scheduled times match", () => {
		expect(newestScheduledPostsFirst([post(4, 1_000), post(5, 1_000)]).map((item) => item.id)).toEqual([5, 4]);
	});
});
