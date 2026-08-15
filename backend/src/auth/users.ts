import { db } from "../db/sqlite.ts";
import type { UserRole, UserRow } from "../db/schema.ts";
import { hashPassword, verifyPassword } from "./password.ts";

export interface AuthUser {
	id: number;
	username: string;
	role: UserRole;
	active: boolean;
	/** How many bots this user may create for themselves. Ignored for admins. */
	botQuota: number;
	/** Excused from the one-LINE-account-per-bot lock (see bot/bots.ts isIdLockExempt). Admins are always exempt regardless of this flag. */
	exemptIdLock: boolean;
}

export interface ManagedUser extends AuthUser {
	createdAt: number;
	botCount: number;
}

/**
 * The ceiling an admin can raise a user to.
 *
 * Five is not arbitrary: each bot runs its own fast poller, and past a
 * handful the extra pollers compete with the very replies they exist to
 * make faster — the effect measured in fast-square-poller.ts.
 */
export const MAX_BOT_QUOTA = 5;
export const DEFAULT_BOT_QUOTA = 1;

/**
 * What an extra bot costs. Lives here so the quota error, the dashboard
 * notice and the user console all quote one number rather than three copies
 * that drift apart the first time the price changes.
 */
export const BOT_PRICE_THB_PER_MONTH = Number(process.env.BOT_PRICE_THB_PER_MONTH ?? 100);

export class UserValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UserValidationError";
	}
}

const adminCountStmt = db.prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'");

const findByUsernameStmt = db.prepare<UserRow, [string]>("SELECT * FROM users WHERE username = ? COLLATE NOCASE");
const getStmt = db.prepare<UserRow, [number]>("SELECT * FROM users WHERE id = ?");
const createStmt = db.prepare<UserRow, [string, string, number]>(
	"INSERT INTO users (username, password_hash, role, active, created_at) VALUES (?, ?, 'user', 1, ?) RETURNING *",
);
const setActiveStmt = db.prepare<null, [number, number]>("UPDATE users SET active = ? WHERE id = ? AND role = 'user'");
const setBotQuotaStmt = db.prepare<null, [number, number]>("UPDATE users SET bot_quota = ? WHERE id = ? AND role = 'user'");
const setExemptIdLockStmt = db.prepare<null, [number, number]>(
	"UPDATE users SET exempt_id_lock = ? WHERE id = ? AND role = 'user'",
);
const setPasswordStmt = db.prepare<null, [string, number]>("UPDATE users SET password_hash = ? WHERE id = ? AND active = 1");
const deleteSessionsStmt = db.prepare<null, [number]>("DELETE FROM auth_sessions WHERE user_id = ?");
const deleteUserStmt = db.prepare<null, [number]>("DELETE FROM users WHERE id = ? AND role = 'user'");

function fromRow(row: UserRow): AuthUser {
	return {
		id: row.id,
		username: row.username,
		role: row.role,
		active: row.active !== 0,
		botQuota: row.bot_quota,
		exemptIdLock: row.exempt_id_lock !== 0,
	};
}

function validateUsername(username: string): string {
	const value = username.trim();
	if (!/^[A-Za-z0-9_.-]{3,50}$/.test(value)) {
		throw new UserValidationError("ชื่อผู้ใช้ต้องยาว 3-50 ตัว และใช้ได้เฉพาะ a-z, 0-9, จุด, ขีดกลาง หรือขีดล่าง");
	}
	return value;
}

function validatePassword(password: string): void {
	if (password.length < 12 || password.length > 200) {
		throw new UserValidationError("รหัสผ่านต้องยาว 12-200 ตัวอักษร");
	}
}

/**
 * Only ever creates the admin account once, on the very first boot against a
 * fresh database. An admin that already exists keeps its stored password —
 * this used to reset it to ADMIN_PASSWORD on every restart, which meant an
 * unset/default env var silently rotated the live admin password back to a
 * known value forever.
 */
function bootstrapAdmin(): UserRow {
	const { count } = adminCountStmt.get()!;
	if (count === 0) {
		const username = process.env.ADMIN_USERNAME;
		const password = process.env.ADMIN_PASSWORD;
		if (!username || !password) {
			throw new Error(
				"No admin account exists yet and ADMIN_USERNAME/ADMIN_PASSWORD are not set. " +
					"Set both env vars (see backend/.env.example) to bootstrap the first admin account.",
			);
		}
		const validUsername = validateUsername(username);
		validatePassword(password);
		db.prepare("INSERT INTO users (username, password_hash, role, active, created_at) VALUES (?, ?, 'admin', 1, ?)")
			.run(validUsername, hashPassword(password), Date.now());
	}
	const admin = db.prepare<UserRow, []>("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1").get()!;
	db.prepare("UPDATE bots SET owner_user_id = ? WHERE owner_user_id IS NULL").run(admin.id);
	return admin;
}

export const bootstrapAdminUser = fromRow(bootstrapAdmin());

export function getUser(id: number): AuthUser | undefined {
	const row = getStmt.get(id);
	return row ? fromRow(row) : undefined;
}

export function findUserWithPassword(username: string): UserRow | undefined {
	return findByUsernameStmt.get(username.trim());
}

export function listUsers(): ManagedUser[] {
	return db.query<UserRow & { bot_count: number }, []>(
		"SELECT users.*, COUNT(bots.id) AS bot_count FROM users LEFT JOIN bots ON bots.owner_user_id = users.id GROUP BY users.id ORDER BY users.role = 'admin' DESC, users.created_at ASC",
	).all().map((row) => ({ ...fromRow(row), createdAt: row.created_at, botCount: row.bot_count }));
}

export function createUser(username: string, password: string): ManagedUser {
	const value = validateUsername(username);
	validatePassword(password);
	if (findByUsernameStmt.get(value)) throw new UserValidationError("ชื่อผู้ใช้นี้มีอยู่แล้ว");
	const row = createStmt.get(value, hashPassword(password), Date.now())!;
	return { ...fromRow(row), createdAt: row.created_at, botCount: 0 };
}

/** Replaces the password and revokes every existing browser session. */
export function changePassword(id: number, currentPassword: string, newPassword: string): boolean {
	const row = getStmt.get(id);
	if (!row || row.active === 0 || !verifyPassword(currentPassword, row.password_hash)) return false;
	if (currentPassword === newPassword) throw new UserValidationError("รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม");
	validatePassword(newPassword);
	db.transaction(() => {
		setPasswordStmt.run(hashPassword(newPassword), id);
		deleteSessionsStmt.run(id);
	})();
	return true;
}

/**
 * Raises or lowers how many bots a user may create. Admin-only at the route.
 *
 * Lowering below what the user already has does not delete anything — they
 * keep the bots and simply cannot create more, which is the right behaviour
 * for a subscription that lapsed rather than an account being punished.
 */
export function setUserBotQuota(id: number, quota: number): AuthUser | undefined {
	const current = getUser(id);
	if (!current || current.role === "admin") return undefined;
	if (!Number.isInteger(quota) || quota < 1 || quota > MAX_BOT_QUOTA) {
		throw new UserValidationError(`โควตาบอทต้องเป็นจำนวนเต็ม 1-${MAX_BOT_QUOTA}`);
	}
	setBotQuotaStmt.run(quota, id);
	return getUser(id);
}

export function setUserActive(id: number, active: boolean): AuthUser | undefined {
	const current = getUser(id);
	if (!current || current.role === "admin") return undefined;
	setActiveStmt.run(active ? 1 : 0, id);
	if (!active) deleteSessionsStmt.run(id);
	return getUser(id);
}

/** Marks (or unmarks) a user's bots exempt from the one-LINE-account-per-bot lock. */
export function setUserExemptIdLock(id: number, exempt: boolean): AuthUser | undefined {
	const current = getUser(id);
	if (!current || current.role === "admin") return undefined;
	setExemptIdLockStmt.run(exempt ? 1 : 0, id);
	return getUser(id);
}

export function deleteUserRecord(id: number): boolean {
	const current = getUser(id);
	if (!current || current.role === "admin") return false;
	db.transaction(() => {
		deleteSessionsStmt.run(id);
		deleteUserStmt.run(id);
	})();
	return true;
}
