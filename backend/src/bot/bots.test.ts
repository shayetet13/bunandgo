import { afterEach, describe, expect, test } from "bun:test";
import { createBot, evaluateIdLock, getBot, isIdLockExempt, listBots, listBotsForUser, resetAllBotStatuses, resetBotLockedLineMid, setBotLockedLineMid, updateBotStatus } from "./bots.ts";
import { db } from "../db/sqlite.ts";
import { setUserExemptIdLock } from "../auth/users.ts";

const insertUserStmt = db.prepare<{ id: number }, [string]>(
	"INSERT INTO users (username, password_hash, created_at) VALUES (?, 'x', 0) RETURNING id",
);

function owner(name: string): number {
	return insertUserStmt.get(name)!.id;
}

const insertAdminStmt = db.prepare<{ id: number }, [string]>(
	"INSERT INTO users (username, password_hash, role, created_at) VALUES (?, 'x', 'admin', 0) RETURNING id",
);

function adminOwner(name: string): number {
	return insertAdminStmt.get(name)!.id;
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

		const admin = { id: 0, username: "admin", role: "admin" as const, active: true, botQuota: 0, exemptIdLock: false };
		const idsForAdmin = listBotsForUser(admin).map((bot) => bot.id);
		expect(idsForAdmin).not.toContain(droppedBot.id);
	});

	test("control-plane listing may include authorized bots from every worker", () => {
		const remoteOwner = owner("control-plane-remote");
		const remoteBot = createBot("control-plane remote", "DESKTOPWIN", remoteOwner);
		process.env.WORKER_OWNER_EXCLUDE = String(remoteOwner);
		const admin = { id: 0, username: "admin", role: "admin" as const, active: true, botQuota: 0, exemptIdLock: false };
		expect(listBotsForUser(admin).map((bot) => bot.id)).not.toContain(remoteBot.id);
		expect(listBotsForUser(admin, { includeAllWorkers: true }).map((bot) => bot.id)).toContain(remoteBot.id);
	});

	test("WORKER_OWNER_SCOPE also filters a non-admin's own bot list when it falls outside scope", () => {
		const ownerId = owner("list-scope-owner");
		const bot = createBot("out of scope bot", "DESKTOPWIN", ownerId);

		process.env.WORKER_OWNER_SCOPE = "999999";
		const user = { id: ownerId, username: "list-scope-owner", role: "user" as const, active: true, botQuota: 5, exemptIdLock: false };
		expect(listBotsForUser(user).map((b) => b.id)).not.toContain(bot.id);
	});
});

describe("one-LINE-account-per-bot lock", () => {
	test("first login locks the bot to that account; the same account matches afterward", () => {
		const ownerId = owner("id-lock-owner");
		const bot = createBot("id-lock bot", "DESKTOPWIN", ownerId);

		expect(evaluateIdLock(bot, "u-alice")).toBe("first_login");
		setBotLockedLineMid(bot.id, "u-alice");

		const locked = getBot(bot.id)!;
		expect(locked.lockedLineMid).toBe("u-alice");
		expect(evaluateIdLock(locked, "u-alice")).toBe("match");
	});

	test("a different account than the one locked in is a mismatch", () => {
		const ownerId = owner("id-lock-mismatch-owner");
		const bot = createBot("id-lock mismatch bot", "DESKTOPWIN", ownerId);
		setBotLockedLineMid(bot.id, "u-alice");

		expect(evaluateIdLock(getBot(bot.id)!, "u-bob")).toBe("mismatch");
	});

	test("an admin's bot is exempt regardless of who logs in", () => {
		const adminId = adminOwner("id-lock-admin");
		const bot = createBot("id-lock admin bot", "DESKTOPWIN", adminId);
		setBotLockedLineMid(bot.id, "u-alice");

		const locked = getBot(bot.id)!;
		expect(isIdLockExempt(locked)).toBe(true);
		expect(evaluateIdLock(locked, "u-bob")).toBe("exempt");
	});

	test("a user explicitly marked exempt is not locked either", () => {
		const ownerId = owner("id-lock-exempt-owner");
		setUserExemptIdLock(ownerId, true);
		const bot = createBot("id-lock exempt bot", "DESKTOPWIN", ownerId);
		setBotLockedLineMid(bot.id, "u-alice");

		const locked = getBot(bot.id)!;
		expect(isIdLockExempt(locked)).toBe(true);
		expect(evaluateIdLock(locked, "u-bob")).toBe("exempt");
	});

	test("an ordinary (non-exempt) user's bot is not exempt", () => {
		const ownerId = owner("id-lock-ordinary-owner");
		const bot = createBot("id-lock ordinary bot", "DESKTOPWIN", ownerId);
		expect(isIdLockExempt(bot)).toBe(false);
	});

	test("an orphaned (unowned) bot is never exempt", () => {
		const bot = createBot("id-lock orphan bot", "DESKTOPWIN", null);
		expect(isIdLockExempt(bot)).toBe(false);
	});

	test("resetting the lock lets a different account become the new first login, without touching other bots", () => {
		const ownerId = owner("id-lock-reset-owner");
		const resetBot = createBot("id-lock reset bot", "DESKTOPWIN", ownerId);
		const siblingBot = createBot("id-lock reset sibling", "DESKTOPWIN", ownerId);
		setBotLockedLineMid(resetBot.id, "u-banned-account");
		setBotLockedLineMid(siblingBot.id, "u-sibling-account");

		resetBotLockedLineMid(resetBot.id);

		const afterReset = getBot(resetBot.id)!;
		expect(afterReset.lockedLineMid).toBeNull();
		expect(evaluateIdLock(afterReset, "u-replacement-account")).toBe("first_login");
		// The sibling's own lock is untouched — this is a single-bot reset,
		// not an owner-wide exemption.
		expect(getBot(siblingBot.id)!.lockedLineMid).toBe("u-sibling-account");
	});
});
