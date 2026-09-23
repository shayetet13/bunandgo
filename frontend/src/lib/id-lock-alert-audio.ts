import { playAlertSiren } from "./siren.ts";
import type { IdLockMismatchEvent } from "./types.ts";

/**
 * Spoken explanation, not just a tone — an operator who is not looking at
 * the screen when this fires still needs to know which bot and what
 * happened, not just that something did. Uses the browser's built-in
 * speechSynthesis (no audio asset to host, license, or keep in sync with
 * the wording above); Thai voice availability depends on the OS/browser, so
 * this stays best-effort exactly like the siren it follows.
 */
function buildWarningText(event: IdLockMismatchEvent): string {
	if (event.reason === "name") {
		return `คำเตือน บอท ${event.botName} มีการเข้าสู่ระบบด้วยชื่อบัญชีไลน์ที่เปลี่ยนไป ขณะที่ยังใช้บอทเดิมอยู่ ระบบปฏิเสธการเข้าสู่ระบบนี้โดยอัตโนมัติ`;
	}
	return `คำเตือน บอท ${event.botName} มีความพยายามเข้าสู่ระบบด้วยบัญชีไลน์อื่น ขณะที่ยังใช้บอทเดิมอยู่ ระบบปฏิเสธการเข้าสู่ระบบนี้โดยอัตโนมัติ`;
}

// Chrome only populates getVoices() asynchronously after the first call (an
// empty list right after page load does not mean "no Thai voice", just "not
// loaded yet"). Warming it here at module load — well before any real
// mismatch can fire — means the availability check below sees the real list
// instead of a false negative on a cold call.
if (typeof window !== "undefined" && "speechSynthesis" in window) {
	window.speechSynthesis.getVoices();
	window.speechSynthesis.addEventListener("voiceschanged", () => window.speechSynthesis.getVoices());
}

function hasThaiVoice(): boolean {
	if (!("speechSynthesis" in window)) return false;
	return window.speechSynthesis.getVoices().some((voice) => voice.lang.toLowerCase().startsWith("th"));
}

/** Returns whether it actually spoke. Never attempts wrong-language or
 * garbled speech — the caller falls back to the siren instead. */
function speakThai(text: string): boolean {
	if (!hasThaiVoice()) return false;
	try {
		const utterance = new SpeechSynthesisUtterance(text);
		utterance.lang = "th-TH";
		utterance.rate = 0.95;
		window.speechSynthesis.speak(utterance);
		return true;
	} catch {
		return false;
	}
}

/** Siren first to grab attention, then either the spoken Thai detail once the
 * wail ends (so the two don't talk over each other) or — when the
 * browser/OS has no Thai voice installed — a second siren instead of
 * speech in the wrong language. */
export function playIdLockMismatchAlert(event: IdLockMismatchEvent): void {
	playAlertSiren();
	window.setTimeout(() => {
		if (!speakThai(buildWarningText(event))) playAlertSiren();
	}, 2200);
}
