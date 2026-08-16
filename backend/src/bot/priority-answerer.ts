/**
 * Gives one business-designated bot ("Big") first claim on a shared room's
 * incoming messages, for a bounded number of jobs per day, so the room
 * doesn't just settle into whichever bot happens to be fastest every single
 * time — see reply-guard.ts's "hottest bot answers" note for why that is
 * the default outcome without this.
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
import { getBot } from "./bots.ts";
import { getCompiledRules, matchRule } from "./rules.ts";

// Comma-separated, case/space-insensitive. Configurable so ops can rename
// or retire the priority bot without a code change.
const PRIORITY_BOT_NAMES = new Set((process.env.PRIORITY_BOT_NAMES ?? "big,bigsa").split(",").map(normalizeName).filter(Boolean));

const PRIORITY_WIN_QUOTA = Number(process.env.PRIORITY_WIN_QUOTA ?? 2);
const PRIORITY_LOOKUP_CACHE_MS = Number(process.env.PRIORITY_LOOKUP_CACHE_MS ?? 1500);

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const SEP = "\0";

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
		.map((row) => ({ botId: row.bot_id, chatMid: row.mid, online: row.status === "online" }));
	cachedAt = now;
	return cachedPriorityRooms;
}

/** Bangkok calendar date, e.g. "2026-08-16" — the daily reset boundary. */
function bangkokDayKey(now: number): string {
	return new Date(now + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

/** (priority bot, room, day) -> wins recorded so far. In-memory like every other reply-guard.ts counter; a restart just grants a fresh daily quota early. */
const wins = new Map<string, number>();

function winsKey(botId: number, chatMid: string, now: number): string {
	return `${botId}${SEP}${chatMid}${SEP}${bangkokDayKey(now)}`;
}

/**
 * Records a priority bot's answer toward its daily quota for `chatMid`.
 * No-op for a non-priority bot, so callers can call this unconditionally
 * on every successful claim without checking `isPriorityBot` themselves.
 * Off the hot path (paid only by an actual send, like primary-bot.ts's
 * own `getBot` lookups), so the direct `isPriorityBot` DB check is fine.
 */
export function recordPriorityWin(botId: number, chatMid: string, now = Date.now()): void {
	if (!isPriorityBot(botId)) return;
	const k = winsKey(botId, chatMid, now);
	wins.set(k, (wins.get(k) ?? 0) + 1);
}

function hasQuotaLeft(botId: number, chatMid: string, now: number): boolean {
	return (wins.get(winsKey(botId, chatMid, now)) ?? 0) < PRIORITY_WIN_QUOTA;
}

/**
 * Whether `candidateBotId` should stand down in `chatMid` and let a
 * priority bot answer `text` instead — checked against every enabled bot
 * in the room, regardless of owner, not just `candidateBotId`'s own
 * siblings (see the module doc for why).
 *
 * False whenever there is nothing to actually gain by yielding: no
 * priority bot in the room, the candidate itself IS the priority bot, the
 * priority bot is offline, its daily quota for this room is already
 * spent, or its own rules would not have matched this message anyway
 * (matching evaluateIdLock-style separation: this is the pure decision,
 * callers own recording the resulting win).
 */
export function shouldYieldToPriorityBot(
	candidateBotId: number,
	chatMid: string,
	text: string,
	surface: Surface,
	now = Date.now(),
): boolean {
	const priorityBot = priorityBotRooms(now).find((room) => room.chatMid === chatMid && room.online && room.botId !== candidateBotId);
	if (!priorityBot) return false;
	if (!hasQuotaLeft(priorityBot.botId, chatMid, now)) return false;
	return matchRule(getCompiledRules(priorityBot.botId), text, surface) !== undefined;
}

/** Test-only: clears every recorded win and forces the next room lookup to hit the DB, so tests are deterministic and don't leak across daily-boundary/cache windows. */
export function clearPriorityWinsForTests(): void {
	wins.clear();
	cachedAt = -Infinity;
}
