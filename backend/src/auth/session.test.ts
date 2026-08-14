import { describe, expect, test } from "bun:test";
import { db } from "../db/sqlite.ts";
import { createSession, destroySession, isValidSession } from "./session.ts";

describe("persistent dashboard sessions", () => {
	test("stores only a hash and remains valid until explicit logout", () => {
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
});
