import type { Bot } from "./types.ts";

export interface BotGroup {
	key: string;
	ownerUserId: number | null;
	bots: Bot[];
}

/**
 * Same key shape as the backend's replyOwnerKey() (session-manager.ts):
 * bots sharing an owner race each other for the same trigger and belong in
 * one group; an unowned bot races alone and gets its own singleton group
 * rather than being lumped in with other unrelated unowned bots.
 */
function groupKey(bot: Bot): string {
	return bot.ownerUserId === null ? `bot:${bot.id}` : `user:${bot.ownerUserId}`;
}

/** Groups preserve `bots`' incoming order, both across and within groups. */
export function groupBotsByOwner(bots: Bot[]): BotGroup[] {
	const groups = new Map<string, BotGroup>();
	for (const bot of bots) {
		const key = groupKey(bot);
		let group = groups.get(key);
		if (!group) {
			group = { key, ownerUserId: bot.ownerUserId, bots: [] };
			groups.set(key, group);
		}
		group.bots.push(bot);
	}
	return [...groups.values()];
}
