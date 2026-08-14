import { createHash, randomBytes } from "node:crypto";
import { db } from "../db/sqlite.ts";
import type { UserRow } from "../db/schema.ts";
import { verifyPassword } from "./password.ts";
import { bootstrapAdminUser, findUserWithPassword, type AuthUser } from "./users.ts";

export const SESSION_COOKIE = "session";

// Also used as the cookie's browser-side maxAge (see api/routes/auth.ts). An
// actively used login renews the cookie's countdown on every authenticated
// call, but the server previously never independently expired the session
// row itself, so a stolen/leaked token stayed valid forever.
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 400;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;

const insertSessionStmt = db.prepare<null, [string, number, number]>(
	"INSERT OR REPLACE INTO auth_sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)",
);
const deleteSessionStmt = db.prepare<null, [string]>("DELETE FROM auth_sessions WHERE token_hash = ?");
const sessionUserStmt = db.prepare<UserRow, [string, number]>(
	"SELECT users.* FROM auth_sessions JOIN users ON users.id = auth_sessions.user_id " +
		"WHERE auth_sessions.token_hash = ? AND users.active = 1 AND auth_sessions.created_at > ?",
);

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function publicUser(row: UserRow): AuthUser {
	return {
		id: row.id,
		username: row.username,
		role: row.role,
		active: row.active !== 0,
		botQuota: row.bot_quota,
	};
}

export function authenticate(username: string, password: string): AuthUser | undefined {
	const row = findUserWithPassword(username);
	if (!row || row.active === 0 || !verifyPassword(password, row.password_hash)) return undefined;
	return publicUser(row);
}

export function createSession(userId = bootstrapAdminUser.id): string {
	const token = randomBytes(32).toString("hex");
	insertSessionStmt.run(hashToken(token), userId, Date.now());
	return token;
}

export function getSessionUser(token: string | undefined): AuthUser | undefined {
	if (!token) return undefined;
	const row = sessionUserStmt.get(hashToken(token), Date.now() - SESSION_MAX_AGE_MS);
	return row ? publicUser(row) : undefined;
}

export function isValidSession(token: string | undefined): boolean {
	return getSessionUser(token) !== undefined;
}

export function destroySession(token: string | undefined): void {
	if (token) deleteSessionStmt.run(hashToken(token));
}
