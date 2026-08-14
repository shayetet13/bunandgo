import type { Bot } from "./types.ts";

/**
 * Merges a fetched bot list over the one on screen without undoing live
 * status updates.
 *
 * `GET /api/bots` answers with the statuses as they were when the request
 * was dispatched. Applying that answer wholesale walks back every transition
 * the WebSocket reported while it was in flight — and a bot that finished
 * logging in inside that window drops from "online" back to "connecting",
 * where the UI puts the scan panel up again with no QR left to show (going
 * online cleared it). Nothing recovers from there, because the single
 * `bot_status` event for that transition has already been and gone.
 *
 * So: everything from the fetch wins, except a status the socket has spoken
 * about more recently than the fetch was dispatched.
 *
 * @param onScreen the list currently rendered
 * @param fetched the list the request answered with
 * @param statusEventAt when each bot's status last moved because of a live event
 * @param fetchedAt when the request was dispatched
 */
export function reconcileFetchedBots(
	onScreen: readonly Bot[],
	fetched: readonly Bot[],
	statusEventAt: ReadonlyMap<number, number>,
	fetchedAt: number,
): Bot[] {
	const liveStatus = new Map(onScreen.map((bot) => [bot.id, bot.status]));
	return fetched.map((bot) => {
		const eventAt = statusEventAt.get(bot.id);
		const live = liveStatus.get(bot.id);
		return live !== undefined && eventAt !== undefined && eventAt >= fetchedAt
			? { ...bot, status: live }
			: bot;
	});
}
