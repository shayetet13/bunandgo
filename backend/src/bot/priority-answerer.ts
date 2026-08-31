/**
 * Gives one business-designated bot ("Big") first claim on a shared room's
 * incoming messages, for a bounded number of jobs — lifetime, across every
 * room it answers in combined, not per room and not per day — so a room
 * doesn't just settle into whichever bot happens to be fastest every single
 * time. Once the quota is spent, every room goes back to a fair race for
 * good, everywhere. See reply-guard.ts's "hottest bot answers" note for why
 * that is the default outcome without this.
 *
 * Each rule-matched message counts on its own toward the quota, including
 * repeats of the same request — there is no time-window job dedup here. A
 * message only ever produces one reply regardless (rules.ts's matchRule
 * stops at the first rule a message matches, and reply-guard.ts's claims
 * make the send exactly-once), so "the same job asked twice" is two real
 * messages and two real answers, not one job double-counted.
 *
 * Deliberately room-wide, not owner-scoped: unlike primary-bot.ts's
 * sibling handoff (same owner only, by design — reply-guard.ts keeps
 * different owners' bots from ever silencing each other, since a shared
 * room can hold competing businesses), this bot's own several accounts sit
 * in one room under *different* owner_user_id rows (one per staff login),
 * so the priority rule has to reach across all of them by bot **name**
 * instead.
 *
 * `shouldYieldToPriorityBot` runs on every rule-matched message from every
 * bot racing to answer it, win or lose — not just the eventual answerer —
 * so it must never touch SQLite directly the way primary-bot.ts's
 * once-per-actual-send lookups can afford to. `chats` has no index usable
 * for "every enabled member of this room" (its primary key is
 * `(bot_id, mid)`, `mid`-first lookups scan it), so a per-message query
 * here would cost that scan on every candidate's every attempt. Instead
 * the (tiny — one or two real accounts) list of priority bots' rooms is
 * cached and refreshed on a short timer, same tradeoff as
 * `REPLY_CLAIM_TTL_MS` elsewhere in this codebase: brief staleness
 * (default 1.5s) is harmless here — a message answered by a non-priority
 * bot instead during that window, or a already-offline priority bot still
 * "seen" as online for a moment, are both fine outcomes for a best-effort
 * fairness rule, not a correctness one.
 *
 * A yield only happens when the priority bot is online AND its own rules
 * would also have matched this exact message (a cheap, already-cached,
 * in-memory check — see rules.ts), so a customer is never left waiting on
 * a bot that had nothing to say.
 */
import type { BotStatus, Surface } from "../db/schema.ts";
import { db } from "../db/sqlite.ts";
import { enqueuePriorityWin } from "../db/write-behind.ts";
import { getBot } from "./bots.ts";
import { getCompiledRules, matchRule } from "./rules.ts";

// Comma-separated, case/space-insensitive. Configurable so ops can rename
// or retire the priority bot without a code change.
const PRIORITY_BOT_NAMES = new Set((process.env.PRIORITY_BOT_NAMES ?? "big,bigsa").split(",").map(normalizeName).filter(Boolean));

const PRIORITY_WIN_QUOTA = Number(process.env.PRIORITY_WIN_QUOTA ?? 2);
const PRIORITY_LOOKUP_CACHE_MS = Number(process.env.PRIORITY_LOOKUP_CACHE_MS ?? 1500);

function normalizeName(name: string): string {
	return name.trim().toLowerCase().replace(/\s+/g, "");
}

/** Whether `botId`'s configured name marks it as the priority answerer. Only ever called off the hot path — see module doc. */
export function isPriorityBot(botId: number): boolean {
	const bot = getBot(botId);
	return bot !== undefined && PRIORITY_BOT_NAMES.has(normalizeName(bot.name));
}

interface PriorityBotRoom {
	botId: number;
	chatMid: string;
	online: boolean;
}

// Every enabled square member of any room, cheap enough to run on the
// (rare, cache-miss-only) refresh: no per-request filter to index against
// anyway, since every bot's own room membership needs checking, not one
// specific room's.
const enabledSquareMembersStmt = db.prepare<{ bot_id: number; name: string; status: BotStatus; mid: string }, []>(
	`SELECT b.id AS bot_id, b.name, b.status, c.mid FROM chats c
	 JOIN bots b ON b.id = c.bot_id
	 WHERE c.surface = 'square' AND c.enabled = 1`,
);

let cachedPriorityRooms: PriorityBotRoom[] = [];
let cachedAt = -Infinity;

function priorityBotRooms(now: number): PriorityBotRoom[] {
	if (now - cachedAt < PRIORITY_LOOKUP_CACHE_MS) return cachedPriorityRooms;
	cachedPriorityRooms = enabledSquareMembersStmt
		.all()
		.filter((row) => PRIORITY_BOT_NAMES.has(normalizeName(row.name)))
		.map((row) => ({ botId: row.bot_id, chatMid: row.mid, online: row.status === "online" }))
		// Sorted once here, not per message: `shouldYieldToPriorityBot` needs a
		// stable order to pick *one* designated answerer out of several
		// priority bots, and it runs on the hot path where a per-call sort
		// would be a needless allocation.
		.sort((left, right) => left.botId - right.botId);
	cachedAt = now;
	return cachedPriorityRooms;
}

/**
 * Priority bot id -> wins recorded so far, lifetime, summed across every
 * room it has ever answered in — once a bot hits PRIORITY_WIN_QUOTA in
 * total, it stays a fair race everywhere from then on; a room does not get
 * its own separate allowance, and nothing about this ever reopens. Hydrated
 * from `priority_answers` at load (same boot-then-mirror shape as
 * chat-access.ts's enabledChatsByBot) so a restart cannot hand out a fresh
 * quota already spent; writes go through the write-behind worker so
 * recording a win never blocks the reply hot path.
 */
const wins = new Map<number, number>();

const hydrateWinsStmt = db.prepare<{ bot_id: number; wins: number }, []>("SELECT bot_id, wins FROM priority_answers");
for (const row of hydrateWinsStmt.all()) {
	wins.set(row.bot_id, row.wins);
}

/**
 * Records a priority bot's answer toward its quota, returning the new count
 * so the caller can log it (see session-manager.ts — this module stays
 * I/O-free of its own accord otherwise, matching evaluateIdLock-style
 * separation). `undefined` for a non-priority bot, so callers can call this
 * unconditionally on every successful claim without checking
 * `isPriorityBot` themselves. Off the hot path (paid only by an actual
 * send, like primary-bot.ts's own `getBot` lookups), so the direct
 * `isPriorityBot` DB check is fine.
 */
export function recordPriorityWin(botId: number): number | undefined {
	if (!isPriorityBot(botId)) return undefined;
	const count = (wins.get(botId) ?? 0) + 1;
	wins.set(botId, count);
	enqueuePriorityWin(botId);
	return count;
}

function hasQuotaLeft(botId: number): boolean {
	return (wins.get(botId) ?? 0) < PRIORITY_WIN_QUOTA;
}

/**
 * Whether `candidateBotId` should stand down in `chatMid` and let a
 * priority bot answer `text` instead — checked against every enabled bot
 * in the room, regardless of owner, not just `candidateBotId`'s own
 * siblings (see the module doc for why).
 *
 * False whenever there is nothing to actually gain by yielding: no
 * priority bot in the room, the candidate itself IS the designated one, the
 * priority bot is offline, its quota (across every room, not just this one)
 * is already spent for good, or its own rules would not have matched this
 * message anyway (matching evaluateIdLock-style separation: this is the
 * pure decision, callers own recording the resulting win).
 *
 * Resolves to a single *designated* answerer rather than "any other
 * priority bot", because `PRIORITY_BOT_NAMES` holds more than one name
 * (`big,bigsa` by default) and the module doc above describes exactly the
 * arrangement where several of them share one room. Asking only "is there
 * another priority bot I should yield to" made each of them yield to the
 * other: every bot in the room stood down and *nobody* answered — and
 * because a win is only recorded by a bot that actually sends, the quota
 * that eventually ends yielding never advanced either, so the room stayed
 * silent for good. Picking the first of a stably ordered list is what makes
 * the relation a strict order instead of a cycle: the designated bot never
 * yields, so there is always exactly one answerer.
 */
export function shouldYieldToPriorityBot(
	candidateBotId: number,
	chatMid: string,
	text: string,
	surface: Surface,
	now = Date.now(),
): boolean {
	const designated = priorityBotRooms(now).find(
		(room) =>
			room.chatMid === chatMid &&
			room.online &&
			hasQuotaLeft(room.botId) &&
			matchRule(getCompiledRules(room.botId), text, surface) !== undefined,
	);
	if (!designated) return false;
	return designated.botId !== candidateBotId;
}

/** Test-only: clears every recorded win and forces the next room lookup to hit the DB, so tests are deterministic and don't leak across cache windows. */
export function clearPriorityWinsForTests(): void {
	wins.clear();
	cachedAt = -Infinity;
}
