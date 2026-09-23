/** Bot events pushed to the dashboard over the /ws socket. */
export const FORWARDED_EVENTS = [
	"qr",
	"pincode",
	"ready",
	"message_in",
	"send_result",
	"send_dropped",
	"fast_path",
	"bot_error",
	"chats_updated",
	"bot_status",
	"start_declined",
	"id_lock_mismatch",
] as const;

export type ForwardedEventName = (typeof FORWARDED_EVENTS)[number];

export function eventBotId(data: unknown): number | undefined {
	if (!data || typeof data !== "object") return undefined;
	const direct = (data as { botId?: unknown }).botId;
	if (typeof direct === "number") return direct;
	const last = (data as { last?: { botId?: unknown } }).last;
	return typeof last?.botId === "number" ? last.botId : undefined;
}
