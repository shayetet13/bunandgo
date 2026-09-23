import { describe, expect, test } from "bun:test";
import { createBot, getBot, listBots, resetAllBotStatuses, updateBotStatus } from "./bots.ts";

/**
 * A restart must not silently strand the bots that were running, and must not
 * claim a dead session is alive. Both halves come out of the same read-then-
 * reset call, so they are asserted together.
 */
describe("restart recovery", () => {
	test("hands back the bots a dead process had running, and marks them offline", () => {
		const online = createBot("was-online");
		const connecting = createBot("was-connecting");
		const idle = createBot("was-offline");
		updateBotStatus(online.id, "online");
		updateBotStatus(connecting.id, "connecting");

		const resumable = resetAllBotStatuses();

		// A bot mid-handshake was just as much "running" as an online one: its
		// session is equally gone, and it equally needs bringing back.
		expect(resumable).toContain(online.id);
		expect(resumable).toContain(connecting.id);
		expect(resumable).not.toContain(idle.id);

		// Nothing may still look alive — no session survived the process.
		for (const bot of listBots()) {
			expect(bot.status).toBe("offline");
		}
		expect(getBot(online.id)?.status).toBe("offline");
	});

	test("reports nothing to resume once statuses are already clear", () => {
		resetAllBotStatuses();
		expect(resetAllBotStatuses()).toEqual([]);
	});
});
