import { beforeEach, describe, expect, test } from "bun:test";
import { createBot } from "./bots.ts";
import { db } from "../db/sqlite.ts";

process.env.DISPATCH_TOKEN ??= "start-confirmation-test-token";
const { clearStartConfirmationsForBot, createStartConfirmation, declineStartConfirmation, getStartConfirmation } =
	await import("./start-confirmation.ts");

beforeEach(() => db.exec("DELETE FROM start_confirmations"));

describe("start confirmations", () => {
	test("reuses one pending DB token and resolves it once", () => {
		const bot = createBot("shared confirmation", "DESKTOPWIN", 717171);
		const first = createStartConfirmation(bot.id);
		expect(createStartConfirmation(bot.id)).toBe(first);
		expect(getStartConfirmation(first)).toMatchObject({ botId: bot.id, status: "pending" });
		expect(declineStartConfirmation(first)).toBe(true);
		expect(declineStartConfirmation(first)).toBe(false);
		expect(getStartConfirmation(first)?.status).toBe("declined");
	});

	test("deleting a bot can clear every associated confirmation", () => {
		const bot = createBot("clear confirmation", "DESKTOPWIN", 737373);
		const token = createStartConfirmation(bot.id);
		clearStartConfirmationsForBot(bot.id);
		expect(getStartConfirmation(token)).toBeUndefined();
	});
});
