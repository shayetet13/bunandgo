import { afterEach, describe, expect, test } from "bun:test";
import { createBot, getBot } from "./bots.ts";
import { db } from "../db/sqlite.ts";
import { createScheduledPost, getScheduledPost } from "./scheduled-posts.ts";

// session-manager.ts requires DISPATCH_TOKEN at module load (shared secret
// with backend/sender); set it before importing, same as routes.test.ts.
process.env.DISPATCH_TOKEN ??= "test-dispatch-token";
const { getRuntimeDiagnostics, scheduledPostBelongsToThisWorker, startBot, stopBot, syncScheduledPostTimer } =
	await import("./session-manager.ts");

// Narrow, focused coverage: only the worker-scope guards added to
// startBot()/stopBot(). The rest of these functions drive a real LINE
// session and have no test harness here — these suites intentionally stop
// at the point the guard short-circuits, before beginLogin() or any of
// stopBot()'s teardown would ever run.

const owner = 424242;
const updateStatusStmt = db.prepare<null, [string, number]>("UPDATE bots SET status = ? WHERE id = ?");

afterEach(() => {
	delete process.env.WORKER_OWNER_SCOPE;
	delete process.env.WORKER_OWNER_EXCLUDE;
});

describe("startBot worker-scope guard", () => {
	test("refuses to start a bot whose owner is outside this process's WORKER_OWNER_SCOPE", async () => {
		const bot = createBot("out-of-scope start", "DESKTOPWIN", owner);
		const before = getRuntimeDiagnostics().runtimes;
		process.env.WORKER_OWNER_SCOPE = "1"; // anything that is not `owner`
		await expect(startBot(bot.id)).rejects.toThrow("ไม่ได้อยู่ในความรับผิดชอบของ worker นี้");
		expect(getRuntimeDiagnostics().runtimes).toBe(before);
	});

	test("refuses to start a bot whose owner is on this process's WORKER_OWNER_EXCLUDE list", async () => {
		const bot = createBot("excluded start", "DESKTOPWIN", owner);
		process.env.WORKER_OWNER_EXCLUDE = String(owner);
		await expect(startBot(bot.id)).rejects.toThrow("ไม่ได้อยู่ในความรับผิดชอบของ worker นี้");
	});
});

describe("stopBot worker-scope guard", () => {
	test("does not retain a runtime for an offline bot", () => {
		const bot = createBot("offline stop", "DESKTOPWIN", owner);
		const before = getRuntimeDiagnostics().runtimes;
		stopBot(bot.id);
		expect(getRuntimeDiagnostics().runtimes).toBe(before);
	});

	test("refuses to touch a bot outside scope, and never flips its shared status to offline", () => {
		const bot = createBot("out-of-scope stop", "DESKTOPWIN", owner);
		// Simulates the bot being genuinely online right now under another,
		// still-running process — the exact state stopBot() must not corrupt.
		updateStatusStmt.run("online", bot.id);
		process.env.WORKER_OWNER_SCOPE = "1"; // anything that is not `owner`

		expect(() => stopBot(bot.id)).toThrow("ไม่ได้อยู่ในความรับผิดชอบของ worker นี้");
		expect(getBot(bot.id)?.status).toBe("online");
	});
});

describe("scheduled post worker ownership", () => {
	test("only the process assigned to the bot may arm or fire its shared timer", () => {
		const bot = createBot("scoped scheduled post", "DESKTOPWIN", owner);
		expect(scheduledPostBelongsToThisWorker(bot.id)).toBe(true);

		process.env.WORKER_OWNER_EXCLUDE = String(owner);
		expect(scheduledPostBelongsToThisWorker(bot.id)).toBe(false);
	});

	test("a non-owner process never disables the rightful worker's due post", async () => {
		const bot = createBot("remote scheduled post", "DESKTOPWIN", owner);
		const post = createScheduledPost(bot.id, {
			surface: "square",
			targetMid: `m${"0".repeat(32)}`,
			text: "still belongs to the shard",
			runAt: Date.now() + 20,
			enabled: true,
		});
		process.env.WORKER_OWNER_EXCLUDE = String(owner);
		syncScheduledPostTimer(bot.id, post.id);
		await Bun.sleep(40);
		expect(getScheduledPost(bot.id, post.id)?.enabled).toBe(true);
	});
});
