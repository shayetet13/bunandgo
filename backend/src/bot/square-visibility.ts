/**
 * Asks LINE whether a reply we sent is actually in the room.
 *
 * A Square send that resolves with `SENT` and ~120ms only proves LINE
 * accepted the call. It does not prove the room shows the message: an
 * account LINE has flagged, or one a room has silenced, gets accepted
 * sends whose messages never reach anyone — and no destroy event is
 * emitted, because nothing was deleted. That failure is invisible from
 * the send side and looks exactly like a rival deleting our replies,
 * while needing the opposite fix.
 *
 * So a short moment after sending, the chat's own event history is read
 * back and searched for the message we just sent. Present means the room
 * has it and anything that removes it afterwards is a deletion we can see;
 * absent means it never landed.
 *
 * Diagnostic only — off unless `SQUARE_VERIFY_SENDS` is set.
 */
import type { Client } from "../linejs-core/client/mod.ts";
import type { SquareEvent } from "../linejs-core/types/line_types.ts";

export const VERIFY_SENDS_ENABLED = process.env.SQUARE_VERIFY_SENDS !== "0";
/**
 * Whether an unverified reply is sent again automatically.
 *
 * Off until the read-back has been observed to be trustworthy in a given
 * room. If `fetchSquareChatEvents` ever fails to return our own message for
 * a reason unrelated to visibility, auto-resend turns that into the bot
 * double-posting at every reply — louder and more damaging than the silence
 * it is meant to fix. Detection first, then this.
 */
export const RESEND_WHEN_INVISIBLE = process.env.SQUARE_RESEND_WHEN_INVISIBLE === "1";
const VERIFY_DELAY_MS = Math.max(200, Number(process.env.SQUARE_VERIFY_DELAY_MS ?? 2_000));
const VERIFY_FETCH_LIMIT = Math.max(1, Number(process.env.SQUARE_VERIFY_LIMIT ?? 50));

export interface VisibilityResult {
	found: boolean;
	/** Message state LINE reports for our message, when it is there at all. */
	state?: unknown;
	/** How many events the room handed back — 0 means we cannot conclude much. */
	scanned: number;
}

interface PayloadEntry {
	squareMessage?: { message?: { id?: string }; state?: unknown };
}

/**
 * Finds our message inside whichever payload slot an event happens to use.
 *
 * A Square event carries its message under a differently named key per
 * event type (`sendMessage`, `receiveMessage`, `notificationMessage`, ...),
 * so every slot is checked rather than guessing which one a read-back
 * returns.
 */
function findMessageState(event: SquareEvent, messageId: string): { found: boolean; state?: unknown } {
	const payload = event.payload as unknown as Record<string, PayloadEntry | undefined>;
	for (const value of Object.values(payload)) {
		const squareMessage = value?.squareMessage;
		if (squareMessage?.message?.id === messageId) return { found: true, state: squareMessage.state };
	}
	return { found: false };
}

/**
 * Reads the room back and reports whether `messageId` is in it.
 *
 * Never throws: a failed read is reported as `scanned: 0` rather than
 * becoming a second failure on top of the one being investigated.
 */
export async function verifyMessageVisible(
	client: Client,
	squareChatMid: string,
	messageId: string,
	delayMs = VERIFY_DELAY_MS,
): Promise<VisibilityResult> {
	await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
	try {
		const response = await client.base.square.fetchSquareChatEvents({
			squareChatMid,
			limit: VERIFY_FETCH_LIMIT,
			direction: "BACKWARD",
		});
		const events = response.events ?? [];
		for (const event of events) {
			const match = findMessageState(event, messageId);
			if (match.found) return { found: true, state: match.state, scanned: events.length };
		}
		return { found: false, scanned: events.length };
	} catch {
		return { found: false, scanned: 0 };
	}
}
