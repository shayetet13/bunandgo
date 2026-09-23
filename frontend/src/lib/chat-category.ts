import type { ChatRow } from "./types.ts";

export type ChatCategory = "direct" | "group" | "oa" | "openchat";
export type ChatCategoryFilter = "all" | ChatCategory;

export const CHAT_CATEGORY_FILTERS: ReadonlyArray<{ id: ChatCategoryFilter; label: string }> = [
	{ id: "all", label: "ทั้งหมด" },
	{ id: "direct", label: "1:1 บุคคล" },
	{ id: "oa", label: "LINE OA" },
	{ id: "openchat", label: "OP Talk" },
	{ id: "group", label: "กลุ่ม LINE" },
];

/**
 * `surface` describes the LINE protocol, not what a person sees in the UI:
 * both a direct conversation and a classic LINE group use `talk`. The MID
 * prefix supplies the missing distinction (`u` = peer, `c`/`r` = group or
 * room), while OA and OpenChat already have dedicated persisted surfaces.
 */
export function chatCategory(chat: Pick<ChatRow, "mid" | "surface">): ChatCategory {
	if (chat.surface === "oa") return "oa";
	if (chat.surface === "square") return "openchat";
	return chat.mid.toLowerCase().startsWith("u") ? "direct" : "group";
}

export function chatCategoryLabel(category: ChatCategory): string {
	switch (category) {
		case "direct":
			return "1:1 บุคคล";
		case "oa":
			return "LINE OA";
		case "openchat":
			return "OP Talk";
		case "group":
			return "กลุ่ม LINE";
	}
}

export function chatLabel(chat: Pick<ChatRow, "mid" | "surface">): string {
	return chatCategoryLabel(chatCategory(chat));
}
