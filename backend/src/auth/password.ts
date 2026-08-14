import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 32;

export function hashPassword(password: string): string {
	const salt = randomBytes(16).toString("hex");
	const hash = scryptSync(password, salt, KEY_LENGTH).toString("hex");
	return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
	const [algorithm, salt, expectedHex] = stored.split("$");
	if (algorithm !== "scrypt" || !salt || !expectedHex) return false;
	const expected = Buffer.from(expectedHex, "hex");
	if (expected.length !== KEY_LENGTH) return false;
	const actual = scryptSync(password, salt, expected.length);
	return timingSafeEqual(actual, expected);
}
