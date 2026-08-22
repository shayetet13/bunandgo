/**
 * Telling "the login failed" apart from "the connection under it broke".
 *
 * Kept separate from the login flow so the classification can be tested
 * against the exact strings the relay and request layers produce.
 */

/**
 * A poll that ran its course without the user acting on the code yet.
 *
 * The server holds the request open for the advertised interval and then
 * answers "nothing happened"; that is a normal tick of the wait.
 */
export function isPollExpiry(message: string): boolean {
	return /Timeout|timed out|status=408|status=410/i.test(message);
}

/**
 * The connection carrying a login RPC broke, without LINE saying anything
 * about the login itself.
 *
 * LINE's edge retires HTTP/2 connections with a GOAWAY as a matter of
 * routine, and the QR poll — deliberately held open for the interval LINE
 * asks for, up to 150s — is by far the request most likely to be holding one
 * when that happens. The Go relay surfaces it as `HTTP 502 upstream: ...
 * GOAWAY`, and treating that as a failed login is what made scanning appear
 * to do nothing: the attempt was torn down and retried with a brand-new QR
 * roughly two seconds later, so whatever the user was looking at (and had
 * just scanned) belonged to a session that had already been abandoned. A
 * dropped socket says nothing about the authentication session, so the right
 * response is to re-issue the request against that same session.
 */
export function isTransientTransportFailure(message: string): boolean {
	return /GOAWAY|HTTP 50[234]\b|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|unexpected EOF|connection (?:closed|reset|refused)|socket hang up|fetch failed|Unable to connect/i.test(
		message,
	);
}

/** How many broken connections one login RPC tolerates before giving up. */
export const MAX_TRANSPORT_RETRIES = 6;

/** Spacing between re-issues, so a hard-down relay cannot become a spin. */
export const TRANSPORT_RETRY_BACKOFF_MS = 1000;

/**
 * Floor on how often the verification loop may re-issue a poll.
 *
 * A poll that answers instantly (an expired session, say) would otherwise
 * let the deadline loop spin at full speed for its entire budget.
 */
export const MIN_POLL_SPACING_MS = 1000;
