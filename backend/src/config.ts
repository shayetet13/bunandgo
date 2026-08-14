/**
 * Central place for reading/validating environment configuration once at
 * boot, instead of scattering `process.env.X ?? fallback` across files.
 *
 * ADMIN_USERNAME/ADMIN_PASSWORD are intentionally NOT validated here — they
 * are only required the very first time the app boots against a database
 * with no admin account yet (see `auth/users.ts` `bootstrapAdmin`). Requiring
 * them unconditionally on every boot would break existing installs that
 * already have an admin account and no longer need those vars set.
 */

const DEFAULT_DEV_ORIGIN = "http://localhost:5173";

function parseOrigins(raw: string | undefined): string[] {
	if (!raw || !raw.trim()) return [DEFAULT_DEV_ORIGIN];
	return raw.split(",").map((origin) => origin.trim()).filter(Boolean);
}

function parsePort(raw: string | undefined): number {
	const port = Number(raw ?? "8790");
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`Invalid PORT env var: ${raw} (must be an integer 1-65535)`);
	}
	return port;
}

export const config = {
	port: parsePort(process.env.PORT),
	allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS),
	dbPath: process.env.DB_PATH ?? (process.env.NODE_ENV === "test" ? ":memory:" : "data/app.db"),
};
