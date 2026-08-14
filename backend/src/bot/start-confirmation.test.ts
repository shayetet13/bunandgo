import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createBot } from "./bots.ts";
import { db } from "../db/sqlite.ts";

process.env.DISPATCH_TOKEN ??= "start-confirmation-test-token";
const {
	acceptStartConfirmation,
	clearStartConfirmationsForBot,
	createStartConfirmation,
	declineStartConfirmation,
	getStartConfirmation,
} = await import("./start-confirmation.ts");

beforeEach(() => db.exec("DELETE FROM start_confirmations"));
afterEach(() => {
	delete process.env.WORKER_OWNER_SCOPE;
	delete process.env.WORKER_OWNER_EXCLUDE;
});

describe("shared start confirmations", () => {
	test("reuses one pending DB token and resolves it once", () => {
		const bot = createBot("shared confirmation", "DESKTOPWIN", 717171);
		const first = createStartConfirmation(bot.id);
		expect(createStartConfirmation(bot.id)).toBe(first);
		expect(getStartConfirmation(first)).toMatchObject({ botId: bot.id, status: "pending" });
		expect(declineStartConfirmation(first)).toBe(true);
		expect(declineStartConfirmation(first)).toBe(false);
		expect(getStartConfirmation(first)?.status).toBe("declined");
	});

	test("a request on the wrong worker does not consume the token", async () => {
		const bot = createBot("misrouted confirmation", "DESKTOPWIN", 727272);
		const token = createStartConfirmation(bot.id);
		process.env.WORKER_OWNER_SCOPE = "1";
		await expect(acceptStartConfirmation(token)).rejects.toThrow("worker ที่ดูแลบอท");
		expect(getStartConfirmation(token)?.status).toBe("pending");
	});

	test("deleting a bot can clear every associated confirmation", () => {
		const bot = createBot("clear confirmation", "DESKTOPWIN", 737373);
		const token = createStartConfirmation(bot.id);
		clearStartConfirmationsForBot(bot.id);
		expect(getStartConfirmation(token)).toBeUndefined();
	});
});
