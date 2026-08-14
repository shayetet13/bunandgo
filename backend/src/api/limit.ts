export function parseLimit(raw: string | undefined, fallback: number, maximum: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(1, Math.trunc(value)));
}
