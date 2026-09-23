import { enqueueUserAction } from "../db/write-behind.ts";
import { db } from "../db/sqlite.ts";
import type { AuthUser } from "./users.ts";

const immediateUserActionStmt = db.prepare<null, [number | null, string, number, string, string | null]>(
	"INSERT INTO user_actions (user_id, username, ts, action, detail) VALUES (?, ?, ?, ?, ?)",
);

/**
 * Persists an audit-trail entry for something an authenticated user did
 * (login, start/stop a bot, edit a rule, ...) for the admin dashboard's
 * history view. `username` is captured at write time rather than joined
 * later, so a row still reads meaningfully after that user is deleted.
 *
 * Goes through the same write-behind worker as latency samples — see
 * bot-events.ts for why this must never be a synchronous DB write here.
 */
export function logUserAction(user: AuthUser, action: string, detail?: unknown): void {
	enqueueUserAction({
		userId: user.id,
		username: user.username,
		ts: Date.now(),
		action,
		detail: detail === undefined ? null : JSON.stringify(detail),
	});
}

/**
 * Persists an audit entry before an operation that is about to terminate this
 * process. The normal write-behind worker is deliberately not used here: a
 * service restart can kill it before the queued message reaches SQLite.
 */
export function logUserActionImmediately(user: AuthUser, action: string, detail?: unknown): void {
	immediateUserActionStmt.run(user.id, user.username, Date.now(), action, detail === undefined ? null : JSON.stringify(detail));
}

/**
 * Records an authentication attempt that did not identify an authenticated
 * user. The submitted username is useful for investigating a suspicious
 * login, but password/token material must never be passed to this helper.
 */
export function logUnauthenticatedUserAction(username: string, action: string, detail?: unknown): void {
	enqueueUserAction({
		userId: null,
		username: username.trim().slice(0, 100) || "(unknown)",
		ts: Date.now(),
		action,
		detail: detail === undefined ? null : JSON.stringify(detail),
	});
}
