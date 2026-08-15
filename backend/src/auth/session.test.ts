import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { db } from "../db/sqlite.ts";
import { createSession, destroySession, isValidSession } from "./session.ts";

describe("dashboard sessions", () => {
	test("stores only a hash and becomes invalid after explicit logout", () => {
		const token = createSession();
		try {
			expect(isValidSession(token)).toBe(true);
			const stored = db.prepare<{ token_hash: string }, []>(
				"SELECT token_hash FROM auth_sessions ORDER BY created_at DESC LIMIT 1",
			).get();
			expect(stored?.token_hash).toHaveLength(64);
			expect(stored?.token_hash).not.toBe(token);
		} finally {
			destroySession(token);
		}
		expect(isValidSession(token)).toBe(false);
	});

	test("expires an idle admin session on the server", () => {
		const token = createSession();
		const tokenHash = createHash("sha256").update(token).digest("hex");
		db.prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?")
			.run(Date.now() - 31 * 60 * 1000, tokenHash);
		expect(isValidSession(token)).toBe(false);
		expect(db.prepare("SELECT 1 FROM auth_sessions WHERE token_hash = ?").get(tokenHash)).toBeNull();
	});

	test("enforces the admin absolute lifetime even if recently active", () => {
		const token = createSession();
		const tokenHash = createHash("sha256").update(token).digest("hex");
		db.prepare("UPDATE auth_sessions SET created_at = ?, last_seen_at = ? WHERE token_hash = ?")
			.run(Date.now() - 13 * 60 * 60 * 1000, Date.now(), tokenHash);
		expect(isValidSession(token)).toBe(false);
	});
});
