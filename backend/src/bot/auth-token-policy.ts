const PERMANENT_AUTH_CODES = new Set([
	"AUTHENTICATION_FAILED",
	"NOT_AUTHORIZED_DEVICE",
	"NOT_AUTHORIZED_SESSION",
	"NOT_AUTHENTICATED",
	"INVALID_IDENTITY_CREDENTIAL",
	"ILLEGAL_IDENTITY_CREDENTIAL",
	"INVALID_SNS_ACCESS_TOKEN",
	"ALREADY_EXPIRED",
]);

function containsPermanentAuthCode(value: unknown, depth = 0): boolean {
	if (typeof value === "string") return PERMANENT_AUTH_CODES.has(value);
	if (!value || typeof value !== "object" || depth >= 4) return false;
	for (const nested of Object.values(value as Record<string, unknown>)) {
		if (containsPermanentAuthCode(nested, depth + 1)) return true;
	}
	return false;
}

/** Only LINE's explicit credential rejection is allowed to erase a reusable token. */
export function shouldDiscardStoredAuthToken(error: unknown): boolean {
	if (containsPermanentAuthCode(error)) return true;
	if (!(error instanceof Error)) return false;
	return [...PERMANENT_AUTH_CODES].some((code) => error.message.includes(code));
}
