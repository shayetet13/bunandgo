import { db } from "../db/sqlite.ts";

/**
 * A user-console-only gate: when on, the bot keeps answering messages exactly
 * as before, and the admin dashboard is untouched — only a "user"-role
 * account's console is replaced with a static notice. Persisted in the shared
 * `app_meta` table (like the restart-worker timestamp) so every worker
 * process and a redeploy both see the same value.
 */
const MAINTENANCE_META_KEY = "system.maintenance_mode";

const getMetaStmt = db.prepare<{ value: string }, [string]>("SELECT value FROM app_meta WHERE key = ?");
const setMetaStmt = db.prepare<null, [string, string]>(
	"INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);

export function isMaintenanceModeEnabled(): boolean {
	return getMetaStmt.get(MAINTENANCE_META_KEY)?.value === "1";
}

export function setMaintenanceMode(enabled: boolean): void {
	setMetaStmt.run(MAINTENANCE_META_KEY, enabled ? "1" : "0");
}
