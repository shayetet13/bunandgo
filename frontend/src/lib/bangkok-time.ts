/**
 * Converts between epoch ms and the wall-clock time an operator picks for a
 * scheduled post — always Asia/Bangkok, regardless of what timezone the
 * browser or server host happens to be in.
 *
 * Thailand has used a fixed UTC+7 offset with no DST since 1920, so the
 * conversion is a plain 7-hour shift rather than anything Intl/timezone-db
 * dependent — the exact instant a "14:00:00.000" post fires must not drift
 * with whatever machine is running the dashboard.
 *
 * Precision goes down to the millisecond on purpose: this schedules a race
 * to be first, where "14:00" (top-of-minute) and "14:00:00.000" already mean
 * the same instant, but the second form is the one that makes it obvious to
 * whoever set it up that no second or millisecond is left ambiguous.
 */
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Parses a `datetime-local` input value (seconds/ms optional) as Bangkok wall time into epoch ms. */
export function bangkokInputToEpochMs(value: string): number | undefined {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
	if (!match) return undefined;
	const [, y, mo, d, h, mi, s, ms] = match;
	const utcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0), ms ? Number(ms.padEnd(3, "0")) : 0);
	return utcMs - BANGKOK_OFFSET_MS;
}

/** Formats epoch ms as a `datetime-local` input value (with seconds+ms) showing Bangkok wall time. */
export function epochMsToBangkokInput(epochMs: number): string {
	const d = new Date(epochMs + BANGKOK_OFFSET_MS);
	const pad = (n: number, width = 2) => String(n).padStart(width, "0");
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

/** Formats epoch ms as a human-readable Bangkok date+time (down to the millisecond) for display. */
export function formatBangkokDateTime(epochMs: number): string {
	const base = new Intl.DateTimeFormat("th-TH", {
		timeZone: "Asia/Bangkok",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).format(new Date(epochMs));
	const ms = String(((epochMs % 1000) + 1000) % 1000).padStart(3, "0");
	return `${base}.${ms}`;
}
