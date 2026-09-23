/**
 * Formats a millisecond duration for display. Shared by every panel that
 * shows latency numbers so a precision tweak only has to happen once —
 * two near-identical private copies of this had already drifted (one
 * lacked the sub-0.01ms floor) before being merged into this one.
 */
export function formatMs(value: number): string {
	if (value < 0.01) return "<0.01ms";
	if (value < 10) return `${value.toFixed(2)}ms`;
	return `${value.toFixed(1)}ms`;
}
