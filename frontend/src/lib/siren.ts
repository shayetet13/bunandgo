/**
 * A short synthesized siren "wail" — no audio asset to host or license, just
 * an oscillator sweep, like a siren winding up and down twice. Used for
 * alerts an operator must not miss mid-scan: an admin announcement just
 * posted, or a login rejected over an ID-lock mismatch. Browsers that block
 * audio without a preceding user gesture (or that lack AudioContext) simply
 * get no sound; this is decoration, never load-bearing, so failures are
 * swallowed.
 */
export function playAlertSiren(): void {
	try {
		const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!AudioContextCtor) return;
		const ctx = new AudioContextCtor();
		void ctx.resume?.().catch(() => {});
		const oscillator = ctx.createOscillator();
		const gain = ctx.createGain();
		oscillator.type = "sine";
		oscillator.connect(gain);
		gain.connect(ctx.destination);
		const now = ctx.currentTime;
		const peak = 0.16;
		gain.gain.setValueAtTime(0.0001, now);
		gain.gain.linearRampToValueAtTime(peak, now + 0.06);
		// Two rise/fall wails, like a siren winding up and down twice.
		oscillator.frequency.setValueAtTime(620, now);
		oscillator.frequency.linearRampToValueAtTime(980, now + 0.5);
		oscillator.frequency.linearRampToValueAtTime(620, now + 1);
		oscillator.frequency.linearRampToValueAtTime(980, now + 1.5);
		oscillator.frequency.linearRampToValueAtTime(620, now + 2);
		gain.gain.setValueAtTime(peak, now + 1.85);
		gain.gain.linearRampToValueAtTime(0.0001, now + 2.1);
		oscillator.start(now);
		oscillator.stop(now + 2.15);
		oscillator.onended = () => void ctx.close().catch(() => {});
	} catch {
		// Best-effort only.
	}
}
