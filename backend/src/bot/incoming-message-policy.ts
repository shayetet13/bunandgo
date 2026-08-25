import type { SquareMessage, TalkMessage } from "../linejs-core/client/mod.ts";
import type { Surface } from "../db/schema.ts";
import { isChatAdminAllowed, isChatAdminOnly, isChatEnabled } from "./chat-access.ts";
import { isSquareAdmin } from "./square-roles.ts";

/** True for a classic Talk group or multi-person room — false for a 1-1 chat. */
export function isGroupOrRoomTalkMessage(message: TalkMessage): boolean {
	const toType = message.to.type;
	return toType === "GROUP" || toType === "ROOM" || toType === 2 || toType === 1;
}

export function shouldProcessIncomingMessage(
	botId: number,
	surface: Surface,
	message: TalkMessage | SquareMessage,
	isKnownOfficialAccountCounterparty = false,
): boolean {
	if (surface !== "square") {
		// Individual 1-1 chats never auto-reply, regardless of chat settings —
		// only groups/rooms, OpenChats (below), and a confirmed LINE Official
		// Account counterparty are eligible. An OA is a service, not a person
		// the bot would be creeping on by replying unprompted, and the caller
		// only ever passes `true` once `oa-contacts.ts` has actually confirmed
		// the mid's botType — an unresolved/unknown 1-1 mid still gets `false`.
		if (!isGroupOrRoomTalkMessage(message as TalkMessage) && !isKnownOfficialAccountCounterparty) return false;
	}

	// Beyond that, a chat must be explicitly enabled — joining a group/OpenChat
	// no longer implies the bot may reply there.
	if (!isChatEnabled(botId, message.to.id)) return false;

	// OpenChat-only: when a room is set to answer admins only, a sender whose
	// role isn't a cached ADMIN/CO_ADMIN is silently skipped. "Talk" (classic
	// group) rows can never have this set — LINE's group protocol has no
	// admin concept to check against — so this only ever narrows square rows.
	// A room may narrow it further to named admins; an empty allowlist keeps
	// the original "any admin" meaning (see chat-access.ts).
	if (surface === "square" && isChatAdminOnly(botId, message.to.id)) {
		return isSquareAdmin(botId, message.to.id, message.from.id) && isChatAdminAllowed(botId, message.to.id, message.from.id);
	}

	return true;
}
