import { createHash, randomBytes } from "node:crypto";
import { db } from "../db/sqlite.ts";
import type { UserRow } from "../db/schema.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import { bootstrapAdminUser, findUserWithPassword, type AuthUser } from "./users.ts";

export const SESSION_COOKIE = "linebot_session";
export const ADMIN_SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;
export const USER_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const ADMIN_IDLE_TIMEOUT_MS = 60 * 30 * 1000;
const USER_IDLE_TIMEOUT_MS = 60 * 60 * 12 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 60 * 5 * 1000;
const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(32).toString("hex"));

interface SessionUserRow extends UserRow {
	session_created_at: number;
	session_last_seen_at: number | null;
}

const insertSessionStmt = db.prepare<null, [string, number, number, number]>(
	"INSERT OR REPLACE INTO auth_sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)",
);
const deleteSessionStmt = db.prepare<null, [string]>("DELETE FROM auth_sessions WHERE token_hash = ?");
const sessionUserStmt = db.prepare<SessionUserRow, [string]>(
	"SELECT users.*, auth_sessions.created_at AS session_created_at, " +
		"auth_sessions.last_seen_at AS session_last_seen_at FROM auth_sessions " +
		"JOIN users ON users.id = auth_sessions.user_id " +
		"WHERE auth_sessions.token_hash = ? AND users.active = 1",
);
const touchSessionStmt = db.prepare<null, [number, string, number]>(
	"UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ? AND COALESCE(last_seen_at, created_at) <= ?",
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
	// Always pay one scrypt verification cost. Otherwise an attacker can infer
	// valid usernames from the much faster unknown-user response.
	const passwordValid = verifyPassword(password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
	if (!row || row.active === 0 || !passwordValid) return undefined;
	return publicUser(row);
}

export function createSession(userId = bootstrapAdminUser.id): string {
	const token = randomBytes(32).toString("hex");
	const now = Date.now();
	insertSessionStmt.run(hashToken(token), userId, now, now);
	return token;
}

export function getSessionUser(token: string | undefined): AuthUser | undefined {
	if (!token) return undefined;
	const tokenHash = hashToken(token);
	const row = sessionUserStmt.get(tokenHash);
	if (!row) return undefined;
	const now = Date.now();
	const maxAgeMs = sessionMaxAgeSeconds(row.role) * 1000;
	const lastSeenAt = row.session_last_seen_at ?? row.session_created_at;
	const idleTimeoutMs = row.role === "admin" ? ADMIN_IDLE_TIMEOUT_MS : USER_IDLE_TIMEOUT_MS;
	if (now - row.session_created_at >= maxAgeMs || now - lastSeenAt >= idleTimeoutMs) {
		deleteSessionStmt.run(tokenHash);
		return undefined;
	}
	// At most one tiny dashboard-only write per five minutes per session. Bot
	// receive/send paths never call this function.
	if (now - lastSeenAt >= SESSION_TOUCH_INTERVAL_MS) {
		touchSessionStmt.run(now, tokenHash, now - SESSION_TOUCH_INTERVAL_MS);
	}
	return publicUser(row);
}

export function sessionMaxAgeSeconds(role: AuthUser["role"]): number {
	return role === "admin" ? ADMIN_SESSION_MAX_AGE_SECONDS : USER_SESSION_MAX_AGE_SECONDS;
}

export function isValidSession(token: string | undefined): boolean {
	return getSessionUser(token) !== undefined;
}

export function destroySession(token: string | undefined): void {
	if (token) deleteSessionStmt.run(hashToken(token));
}
