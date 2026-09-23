import type { Bot } from "./types.ts";

function normalize(value: string | number | null | undefined): string {
	return String(value ?? "")
		.normalize("NFKC")
		.toLocaleLowerCase("th")
		.trim();
}

/** Matches every name/id a dashboard operator can reasonably see or copy. */
export function botMatchesSearch(bot: Bot, rawQuery: string): boolean {
	const query = normalize(rawQuery);
	if (!query) return true;
	return [
		bot.name,
		bot.id,
		`#${bot.id}`,
		`id ${bot.id}`,
		`bot${bot.id}`,
		`bot${bot.slot}`,
		bot.lockedLineMid,
		bot.lockedLineDisplayName,
	].some((value) => normalize(value).includes(query));
}
