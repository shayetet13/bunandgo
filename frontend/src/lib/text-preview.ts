/**
 * Compact rule-list rows render on one line (CSS white-space: nowrap), which
 * silently collapses real newlines into invisible spaces — a saved
 * multi-line reply then looks identical to a single-line one. Swap
 * newlines for a visible marker so the line breaks are still visible in
 * the preview; this is display-only and never touches the stored text
 * that actually gets sent to LINE.
 */
export function previewReplyText(text: string): string {
	return text.includes("\n") ? text.replace(/\n+/g, " ⏎ ") : text;
}
