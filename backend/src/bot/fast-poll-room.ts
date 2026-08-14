/**
 * Picks which OpenChats a bot's fast pollers watch.
 *
 * How many is a budget, not a fixed one. Every extra room is another
 * continuous request stream competing with the reply it exists to make
 * faster — the effect measured on 2026-08-09 when a single room was given a
 * second worker (17.8ms -> 36.3ms; see FAST_SQUARE_POLL_WORKERS in
 * fast-square-poller.ts) — so the default stays at one and raising it is a
 * deliberate act with a measurement behind it.
 *
 * The budget is per bot, and a bot is one LINE account. Covering four rooms
 * therefore does not need four accounts: it needs one bot allowed four
 * rooms. That is the whole reason this is configurable rather than pinned.
 *
 * Which rooms is picked here rather than by hand: a bot joins rooms it did
 * not have when anyone last looked at the dashboard, and a room left on the
 * slow push path loses by ~100ms without anything saying so.
 *
 * Switching is not free — a new room re-drains its history before delivering
 * anything (see `runFastSquarePoller`'s priming) — so choices are sticky: a
 * room still seeing traffic keeps its poller, and a lull where no room has
 * traffic never causes a switch at all.
 *
 * Siblings of the same owner no longer avoid each other's rooms here. That
 * used to matter because a second reply from a second bot meant the room
 * saw the same answer twice — primary-bot.ts routes every reply through one
 * designated answerer now, so two bots fast-polling the one room that
 * actually matters is pure upside (another independent detection cycle, at
 * no cost of a second visible reply), not the fraction-of-a-cycle-for-a-
 * still-uncovered-room tradeoff it used to be. Ranking by traffic alone
 * already sends a fleet's spare budget to its busiest room on its own.
 */

export interface FastPollCandidate {
	mid: string;
	/** Incoming messages seen in this room inside the activity window. */
	recentMessages: number;
}

/**
 * `candidates` is every OpenChat the bot is allowed to reply in, most
 * recently joined first — that order is the tie-break, so it must be stable
 * across calls. `current` is what this bot polls right now.
 *
 * Returns at most `limit` rooms, best first.
 */
export function selectFastPollRooms(
	candidates: readonly FastPollCandidate[],
	current: readonly string[],
	limit = 1,
): string[] {
	if (limit <= 0 || candidates.length === 0) return [];

	const currentSet = new Set(current);
	// A quiet room is only worth leaving for a busy one. When nothing
	// anywhere has traffic, "busiest" would be decided by the tie-break
	// alone, and re-priming a poller to land on an equally silent room buys
	// nothing and costs the drain.
	const anyActive = candidates.some((candidate) => candidate.recentMessages > 0);

	const keep: FastPollCandidate[] = [];
	const rest: FastPollCandidate[] = [];

	for (const candidate of candidates) {
		const sticky = currentSet.has(candidate.mid) && (candidate.recentMessages > 0 || !anyActive);
		if (sticky) keep.push(candidate);
		else rest.push(candidate);
	}

	// `keep` stays in the caller's order so an unchanged situation returns an
	// unchanged answer. `rest` ranks by traffic, and `sort` on a pre-ordered
	// array leaves equal entries where they were.
	byTrafficDesc(rest);

	return [...keep, ...rest].slice(0, limit).map((candidate) => candidate.mid);
}

function byTrafficDesc(candidates: FastPollCandidate[]): void {
	candidates.sort((a, b) => b.recentMessages - a.recentMessages);
}
