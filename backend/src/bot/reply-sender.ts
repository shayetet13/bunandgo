import type { Client, SquareMessage, TalkMessage } from "../linejs-core/client/mod.ts";
import type { Surface } from "../db/schema.ts";

/**
 * Picks the fastest way to answer a given message.
 *
 * `TalkMessage.reply` builds a full thrift `sendMessage`; LINE also accepts
 * a compact binary form on `/CA5` that carries the same content in a
 * fraction of the bytes. Compact cannot express a threaded reply and only
 * addresses user/room/group mids, so it is used where it applies and the
 * thrift path stays as the fallback.
 */

/** Compact addressing understands these mid prefixes and no others. */
const COMPACT_MID_PREFIXES = new Set(["u", "r", "c"]);

/**
 * Resolves who a talk reply is addressed to.
 *
 * Mirrors `TalkMessage.reply`: in a group or room the conversation is the
 * target, but in a one-to-one chat `to` is *us*, so answering it would
 * send the reply to ourselves.
 */
function talkReplyTarget(message: TalkMessage): string {
	if (message.to.type === "GROUP" || message.to.type === "ROOM") {
		return message.to.id;
	}
	return message.isMyMessage ? message.to.id : message.from.id;
}

function canUseCompact(to: string): boolean {
	return COMPACT_MID_PREFIXES.has(to[0] ?? "") && /^[0-9a-f]{32}$/i.test(to.slice(1));
}

/**
 * Answers `message` with `text`.
 *
 * Square keeps the thrift path because it has no compact endpoint.
 */
export function sendReply(
	client: Client,
	surface: Surface,
	message: TalkMessage | SquareMessage,
	text: string,
): Promise<unknown> {
	if (surface === "square") {
		const squareMessage = message as SquareMessage;
		return client.base.square.sendMessage({
			squareChatMid: squareMessage.raw.message.to,
			text,
			// The relay already reads LINE's complete response body before it
			// resolves, so ACK_ONLY saves only the local Thrift decode. Keeping
			// the full result here gives noteSquareSendResult the message id and
			// state needed to distinguish SENT from DELETED/FORBIDDEN and to arm
			// the visibility/destroy checks. Without it a reply can be reported
			// as successful while never becoming visible in the room.
			fastAck: false,
		});
	}

	const talkMessage = message as TalkMessage;
	const to = talkReplyTarget(talkMessage);
	if (!canUseCompact(to)) return talkMessage.reply(text);

	return client.base.talk.sendCompactMessage({
		to,
		text,
		fastAck: true,
		// An encrypted incoming message means an encrypted chat, so the
		// answer has to be encrypted too. Leaving this undefined otherwise
		// keeps LINE's own plain-then-encrypted retry available rather than
		// paying for encryption in chats that do not require it.
		...(talkMessage.raw.chunks ? { e2ee: true as const } : {}),
	});
}
