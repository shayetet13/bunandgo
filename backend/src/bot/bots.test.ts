import { afterEach, describe, expect, test } from "bun:test";
import { createBot, listBots, listBotsForUser, resetAllBotStatuses, updateBotStatus } from "./bots.ts";
import { db } from "../db/sqlite.ts";

const insertUserStmt = db.prepare<{ id: number }, [string]>(
	"INSERT INTO users (username, password_hash, created_at) VALUES (?, 'x', 0) RETURNING id",
);

function owner(name: string): number {
	return insertUserStmt.get(name)!.id;
}

afterEach(() => {
	delete process.env.WORKER_OWNER_SCOPE;
	delete process.env.WORKER_OWNER_EXCLUDE;
});

describe("resetAllBotStatuses scoping", () => {
	test("unscoped (default): resets every non-offline bot, regardless of owner", () => {
		const a = owner("reset-a");
		const b = owner("reset-b");
		const botA = createBot("reset bot a", "DESKTOPWIN", a);
		const botB = createBot("reset bot b", "DESKTOPWIN", b);
		updateBotStatus(botA.id, "online");
		updateBotStatus(botB.id, "online");

		const running = resetAllBotStatuses();

		expect(running).toContain(botA.id);
		expect(running).toContain(botB.id);
		expect(listBots().find((b2) => b2.id === botA.id)?.status).toBe("offline");
		expect(listBots().find((b2) => b2.id === botB.id)?.status).toBe("offline");
	});

	test("scoped via WORKER_OWNER_SCOPE: only resets/returns bots for the listed owner, leaves the other owner's status untouched", () => {
		const mine = owner("reset-scope-mine");
		const theirs = owner("reset-scope-theirs");
		const myBot = createBot("scoped mine", "DESKTOPWIN", mine);
		const theirBot = createBot("scoped theirs", "DESKTOPWIN", theirs);
		updateBotStatus(myBot.id, "online");
		updateBotStatus(theirBot.id, "online");

		process.env.WORKER_OWNER_SCOPE = String(mine);
		const running = resetAllBotStatuses();

		expect(running).toEqual([myBot.id]);
		// The other owner's bot is left exactly as another, still-running
		// process on that owner's bots left it — never touched by this call.
		const theirRow = db.query<{ status: string }, [number]>("SELECT status FROM bots WHERE id = ?").get(theirBot.id);
		expect(theirRow?.status).toBe("online");
	});
});

describe("listBots / listBotsForUser scoping", () => {
	test("unscoped: every bot is listed, admin or not", () => {
		const a = owner("list-a");
		const b = owner("list-b");
		const botA = createBot("list bot a", "DESKTOPWIN", a);
		const botB = createBot("list bot b", "DESKTOPWIN", b);

		const ids = listBots().map((bot) => bot.id);
		expect(ids).toContain(botA.id);
		expect(ids).toContain(botB.id);
	});

	test("WORKER_OWNER_EXCLUDE hides an excluded owner's bots from listBots even for an admin caller", () => {
		const kept = owner("list-exclude-kept");
		const dropped = owner("list-exclude-dropped");
		const keptBot = createBot("kept bot", "DESKTOPWIN", kept);
		const droppedBot = createBot("dropped bot", "DESKTOPWIN", dropped);

		process.env.WORKER_OWNER_EXCLUDE = String(dropped);
		const ids = listBots().map((bot) => bot.id);

		expect(ids).toContain(keptBot.id);
		expect(ids).not.toContain(droppedBot.id);

		const admin = { id: 0, username: "admin", role: "admin" as const, active: true, botQuota: 0 };
		const idsForAdmin = listBotsForUser(admin).map((bot) => bot.id);
		expect(idsForAdmin).not.toContain(droppedBot.id);
	});

	test("control-plane listing may include authorized bots from every worker", () => {
		const remoteOwner = owner("control-plane-remote");
		const remoteBot = createBot("control-plane remote", "DESKTOPWIN", remoteOwner);
		process.env.WORKER_OWNER_EXCLUDE = String(remoteOwner);
		const admin = { id: 0, username: "admin", role: "admin" as const, active: true, botQuota: 0 };
		expect(listBotsForUser(admin).map((bot) => bot.id)).not.toContain(remoteBot.id);
		expect(listBotsForUser(admin, { includeAllWorkers: true }).map((bot) => bot.id)).toContain(remoteBot.id);
	});

	test("WORKER_OWNER_SCOPE also filters a non-admin's own bot list when it falls outside scope", () => {
		const ownerId = owner("list-scope-owner");
		const bot = createBot("out of scope bot", "DESKTOPWIN", ownerId);

		process.env.WORKER_OWNER_SCOPE = "999999";
		const user = { id: ownerId, username: "list-scope-owner", role: "user" as const, active: true, botQuota: 5 };
		expect(listBotsForUser(user).map((b) => b.id)).not.toContain(bot.id);
	});
});
