/**
 * Out-of-band notification for the one failure nobody is watching for.
 *
 * The dashboard already shows a bot going offline, but only to someone who
 * has it open — which is how a session that died overnight was first noticed
 * by the people in the LINE rooms rather than by us. This pushes the same
 * transition to a channel that reaches a phone.
 *
 * Deliberately out-of-band rather than LINE: the failure being reported is
 * usually LINE itself refusing the account, so an alert that travels over
 * LINE would be silenced by exactly the outage it exists to announce. The
 * configured Telegram chats and generic webhooks are all attempted.
 */

/**
 * Alert destinations are read when an alert is emitted rather than once at
 * module load. This keeps tests deterministic and also lets a long-running
 * process pick up an environment update after a supervised restart without
 * having to rebuild any monitoring state.
 */
function splitConfiguredList(value: string | undefined): string[] {
	return (value ?? "")
		.split(/[\s,]+/)
		.map((item) => item.trim())
		.filter(Boolean);
}

function telegramDestinations(): { token: string; chatIds: string[] } | undefined {
	const token = process.env.ALERT_TELEGRAM_BOT_TOKEN?.trim();
	if (!token) return undefined;
	const chatIds = splitConfiguredList(process.env.ALERT_TELEGRAM_CHAT_IDS ?? process.env.ALERT_TELEGRAM_CHAT_ID);
	return chatIds.length > 0 ? { token, chatIds } : undefined;
}

function webhookDestinations(): string[] {
	const configured = splitConfiguredList(`${process.env.ALERT_WEBHOOK_URLS ?? ""} ${process.env.ALERT_WEBHOOK_URL ?? ""}`);
	return [...new Set(configured)].filter((url) => {
		try {
			const parsed = new URL(url);
			return parsed.protocol === "https:" || parsed.protocol === "http:";
		} catch {
			console.error(`[alerts] ignoring invalid webhook URL: ${url.slice(0, 120)}`);
			return false;
		}
	});
}

/** How long the same bot+kind pair stays suppressed after firing. */
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const SEND_TIMEOUT_MS = 8000;

export type AlertKind =
	| "offline"
	| "recovered"
	| "login_required"
	| "reply_blocked"
	| "system_overload"
	| "system_recovered"
	| "security_intrusion";

const lastSentAt = new Map<string, number>();

export function alertsConfigured(): boolean {
	const telegram = telegramDestinations();
	return Boolean((telegram && telegram.chatIds.length > 0) || webhookDestinations().length > 0);
}

/**
 * True when this alert should actually be sent.
 *
 * A flapping session would otherwise mint one message per reconnect attempt;
 * a bot stuck in the QR-retry loop used to produce one every few seconds.
 * Exported so the policy is testable without a network call.
 */
export function shouldSendAlert(
	key: string,
	nowMs: number,
	seen: Map<string, number> = lastSentAt,
): boolean {
	const previous = seen.get(key);
	if (previous !== undefined && nowMs - previous < DEDUPE_WINDOW_MS) return false;
	// Security alerts may contain an attacker-controlled IP/path fingerprint.
	// Bound the shared map so rotating those values cannot turn monitoring into
	// a process-memory denial of service.
	if (!seen.has(key) && seen.size >= 10_000) {
		const oldest = seen.keys().next().value;
		if (oldest !== undefined) seen.delete(oldest);
	}
	seen.set(key, nowMs);
	return true;
}

/** Recovery must be able to re-arm the "went down" alert immediately. */
export function clearAlertDedupe(key: string, seen: Map<string, number> = lastSentAt): void {
	seen.delete(key);
}

function format(kind: AlertKind, botName: string, detail?: string): string {
	const suffix = detail ? `\n${detail}` : "";
	switch (kind) {
		case "offline":
			return `🔴 บอท "${botName}" ออฟไลน์แล้ว${suffix}`;
		case "login_required":
			return `⚠️ บอท "${botName}" ต้องสแกน QR ใหม่ — เซสชันเดิมใช้ไม่ได้แล้ว${suffix}`;
		case "recovered":
			return `🟢 บอท "${botName}" กลับมาออนไลน์แล้ว${suffix}`;
		case "reply_blocked":
			return `🚫 บอท "${botName}" ตอบไปแล้วแต่ห้องไม่เห็น/ถูกลบ/ถูกปฏิเสธ${suffix}`;
		case "system_overload":
			return `🔥 ระบบบอทใช้ทรัพยากรเกินขีดจำกัด${suffix}`;
		case "system_recovered":
			return `✅ โหลดระบบบอทกลับสู่ระดับปกติแล้ว${suffix}`;
		case "security_intrusion":
			return `🚨 ตรวจพบความพยายามเข้าถึงระบบผิดปกติ${suffix}`;
	}
}

async function post(url: string, body: unknown): Promise<void> {
	// An alert that hangs must not hold anything else up; the caller is
	// fire-and-forget and there is nothing useful to do with a failure beyond
	// logging it, since the failure channel is what is broken.
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`alert endpoint answered HTTP ${res.status}`);
	}
}

/**
 * Sends one alert, unless an identical one fired inside the dedupe window.
 *
 * Never throws and never returns a rejected promise the caller has to catch:
 * a monitoring path that can itself take the process down is worse than no
 * monitoring at all.
 */
export function sendAlert(
	kind: AlertKind,
	botId: number,
	botName: string,
	detail?: string,
	dedupeKey?: string,
): void {
	if (!alertsConfigured()) return;
	const key = dedupeKey ?? `${botId}:${kind}`;
	if (!shouldSendAlert(key, Date.now())) return;
	// Coming back up makes the matching failure newsworthy again, and vice versa.
	const opposite = kind === "recovered"
		? "offline"
		: kind === "offline"
		? "recovered"
		: kind === "system_recovered"
		? "system_overload"
		: kind === "system_overload"
		? "system_recovered"
		: undefined;
	if (opposite) clearAlertDedupe(`${botId}:${opposite}`);

	const text = format(kind, botName, detail);
	void (async () => {
		const telegram = telegramDestinations();
		const webhooks = webhookDestinations();
		const deliveries: Promise<void>[] = [];
		if (telegram) {
			for (const chatId of telegram.chatIds) {
				deliveries.push(post(`https://api.telegram.org/bot${telegram.token}/sendMessage`, {
					chat_id: chatId,
					text,
					disable_notification: kind === "recovered" || kind === "system_recovered",
				}));
			}
		}
		for (const webhook of webhooks) {
			// Discord reads `content`; most other webhook receivers read
			// `text`. Sending both costs nothing and avoids a per-provider
			// switch for what is one short string. Every configured endpoint is
			// attempted independently, so one failed channel cannot suppress the
			// others.
			deliveries.push(post(webhook, { content: text, text, kind, botId, botName }));
		}
		const results = await Promise.allSettled(deliveries);
		for (const result of results) {
			if (result.status === "rejected") {
				console.error(`[alerts] could not deliver "${text}":`, result.reason instanceof Error ? result.reason.message : result.reason);
			}
		}
	})();
}
