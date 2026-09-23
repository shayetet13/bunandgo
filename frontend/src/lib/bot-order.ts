import type { Bot } from "./types.ts";
import { groupBotsByOwner } from "./group-bots.ts";

function move<T>(items: readonly T[], from: number, to: number): T[] {
	const next = [...items];
	const [item] = next.splice(from, 1);
	if (item === undefined) return next;
	next.splice(to, 0, item);
	return next;
}

/**
 * Reorders siblings directly. Crossing an owner boundary moves the complete
 * owner group, because dragging a card must never change its owner.
 */
export function moveBotCard(bots: readonly Bot[], draggedId: number, targetId: number): Bot[] {
	if (draggedId === targetId) return [...bots];
	const groups = groupBotsByOwner([...bots]);
	const sourceGroupIndex = groups.findIndex((group) => group.bots.some((bot) => bot.id === draggedId));
	const targetGroupIndex = groups.findIndex((group) => group.bots.some((bot) => bot.id === targetId));
	if (sourceGroupIndex < 0 || targetGroupIndex < 0) return [...bots];

	if (sourceGroupIndex === targetGroupIndex) {
		const group = groups[sourceGroupIndex]!;
		const from = group.bots.findIndex((bot) => bot.id === draggedId);
		const to = group.bots.findIndex((bot) => bot.id === targetId);
		groups[sourceGroupIndex] = { ...group, bots: move(group.bots, from, to) };
		return groups.flatMap((item) => item.bots);
	}

	return move(groups, sourceGroupIndex, targetGroupIndex).flatMap((group) => group.bots);
}

/** Applies an optimistic visible reorder without changing stable bot labels. */
export function applyVisibleBotOrder(bots: readonly Bot[], orderedIds: readonly number[]): Bot[] {
	if (bots.length !== orderedIds.length || new Set(orderedIds).size !== orderedIds.length) return [...bots];
	const byId = new Map(bots.map((bot) => [bot.id, bot]));
	const ordered = orderedIds.map((id) => byId.get(id));
	if (ordered.some((bot) => !bot)) return [...bots];
	return ordered.map((bot) => bot!);
}
