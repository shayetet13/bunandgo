/**
 * How long LINE took to hand us a message after it was posted.
 *
 * Every latency number this project reports starts the clock when *we*
 * receive a message. That measures our half of the race and nothing else:
 * two bots answering the same trigger both start their stopwatch at
 * different real-world moments, and the one LINE notifies first can be
 * slower at every subsequent step and still post first. A 20ms reply that
 * started 80ms late loses to a 50ms reply that started on time, and from
 * inside our own metrics that loss is invisible — the dashboard shows a
 * perfect 20ms either way.
 *
 * LINE stamps every message with `createdTime` when its server accepts it.
 * The gap between that and our own clock at receipt is the part of the race
 * we were blind to.
 *
 * Caveat this number honestly: it spans two machines, so it carries
 * whatever clock offset exists between LINE's servers and ours. A single
 * absolute reading proves little; the *distribution* over many messages,
 * and any sudden change in it, is what carries signal.
 */
import type { SquareMessage, TalkMessage } from "../linejs-core/client/mod.ts";
import type { Surface } from "../db/schema.ts";

/** Above this, an inbound delay is recorded as an anomaly. */
export const SLOW_INBOUND_MS = Math.max(0, Number(process.env.INBOUND_SLOW_MS ?? 400));

/** `Int64` reaches us as a number or a bigint depending on the decoder path. */
function toEpochMs(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "bigint") return Number(value);
	return undefined;
}

/** LINE's own stamp for a message, on the clock every participant shares. */
export function lineCreatedTimeOf(surface: Surface, message: TalkMessage | SquareMessage): number | undefined {
	const raw =
		surface === "talk"
			? toEpochMs((message as TalkMessage).raw.createdTime)
			: toEpochMs((message as SquareMessage).raw.message.createdTime);
	return raw !== undefined && raw > 0 ? raw : undefined;
}

function createdTimeOf(surface: Surface, message: TalkMessage | SquareMessage): number | undefined {
	return lineCreatedTimeOf(surface, message);
}

/** Same conversion, for the message LINE hands back from a send. */
export function toLineEpochMs(value: unknown): number | undefined {
	const ms = toEpochMs(value);
	return ms !== undefined && ms > 0 ? ms : undefined;
}

/**
 * Milliseconds between LINE stamping the message and us holding it, or
 * undefined when the message carries no usable timestamp.
 *
 * Negative results are returned as-is rather than clamped: a consistently
 * negative value means our clock runs ahead of LINE's, which is a fact
 * worth seeing rather than hiding behind a zero.
 */
export function inboundDelayMs(surface: Surface, message: TalkMessage | SquareMessage, now = Date.now()): number | undefined {
	const createdTime = createdTimeOf(surface, message);
	if (createdTime === undefined || createdTime <= 0) return undefined;
	return now - createdTime;
}

/** Whether a measured delay is far enough out of line to be worth recording. */
export function isSlowInbound(delayMs: number | undefined): delayMs is number {
	return delayMs !== undefined && delayMs > SLOW_INBOUND_MS;
}
