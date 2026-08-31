/**
 * Feature flags for detecting (and optionally recovering from) a reply that
 * LINE accepted but never actually shows in the room.
 *
 * A Square send that resolves with `SENT` and ~120ms only proves LINE
 * accepted the call. It does not prove the room shows the message: an
 * account LINE has flagged, or one a room has silenced, gets accepted
 * sends whose messages never reach anyone — and no destroy event is
 * emitted, because nothing was deleted. That failure is invisible from
 * the send side and looks exactly like a rival deleting our replies,
 * while needing the opposite fix.
 *
 * Detection itself lives in square-forensics.ts, which watches the
 * already-running event streams after a send instead of issuing a
 * dedicated read-back request (an earlier BACKWARD-fetch approach was
 * dropped so no diagnostic request could queue behind or compete with the
 * latency-sensitive room poll lane — see session-manager.ts). These two
 * flags gate that detection and the optional auto-resend.
 *
 * Diagnostic only — off unless `SQUARE_VERIFY_SENDS` is set.
 */
export const VERIFY_SENDS_ENABLED = process.env.SQUARE_VERIFY_SENDS !== "0";
/**
 * Whether an unverified reply is sent again automatically.
 *
 * Off until the read-back has been observed to be trustworthy in a given
 * room. If the forensics detection ever fails to recognize our own message
 * for a reason unrelated to visibility, auto-resend turns that into the bot
 * double-posting at every reply — louder and more damaging than the silence
 * it is meant to fix. Detection first, then this.
 */
export const RESEND_WHEN_INVISIBLE = process.env.SQUARE_RESEND_WHEN_INVISIBLE === "1";
