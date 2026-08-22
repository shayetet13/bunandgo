import { assignedWorkerForOwner, stickyAssignmentEnabled } from "./worker-assignment.ts";

/**
 * Which bots this OS process is allowed to run, when the backend is split
 * across more than one process to use more than one CPU core.
 *
 * The reply/poll hot path is single-threaded (one JS event loop), so a
 * second CPU core only gets used by running a second copy of this same
 * process. Splitting must happen along owner boundaries — reply-guard.ts's
 * `roomAnswers`, primary-bot.ts's send handoff, and the sibling fast-poll
 * nudge in session-manager.ts all assume every bot of one owner lives in
 * the same process's in-memory state. Unset (both env vars absent) keeps
 * today's behaviour exactly: one process, every bot.
 */

/**
 * Thrown whenever an action targets a bot (or a user whose bots) this
 * process is not assigned. Its own type so callers — bot-detail.ts's
 * start/stop routes, users.ts's quota/active routes — can tell "this is a
 * routing mismatch, tell the operator which worker actually owns this"
 * apart from a genuine server error, instead of both collapsing into the
 * same generic 500.
 */
export class WorkerScopeError extends Error {}

export function parseWorkerOwnerIds(raw: string, envName = "worker owner list"): Set<number> {
	const ids = new Set<number>();
	for (const part of raw.split(",")) {
		const value = part.trim();
		if (!value) continue;
		const id = Number(value);
		if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(id)) {
			throw new Error(`${envName} contains an invalid owner id: ${value}`);
		}
		ids.add(id);
	}
	if (ids.size === 0) throw new Error(`${envName} must contain at least one owner id`);
	return ids;
}

/**
 * Re-read on every call rather than cached at module load: this is never on
 * the reply/poll hot path (it gates `startBot`, boot-time resume, and the
 * bot list — all rare, human- or boot-triggered), and reading fresh keeps
 * this testable without module-cache-busting gymnastics while behaving
 * identically in production, where systemd sets these once and never
 * changes them for the life of the process.
 */
export interface WorkerScopeConfig {
	include?: Set<number>;
	exclude?: Set<number>;
}

export function resolveWorkerScope(): WorkerScopeConfig {
	const includeRaw = process.env.WORKER_OWNER_SCOPE?.trim();
	const excludeRaw = process.env.WORKER_OWNER_EXCLUDE?.trim();
	if (includeRaw && excludeRaw) {
		throw new Error("ตั้งค่าได้แค่ WORKER_OWNER_SCOPE หรือ WORKER_OWNER_EXCLUDE อย่างใดอย่างหนึ่ง ไม่ใช่ทั้งคู่พร้อมกัน");
	}
	return {
		include: includeRaw ? parseWorkerOwnerIds(includeRaw, "WORKER_OWNER_SCOPE") : undefined,
		exclude: excludeRaw ? parseWorkerOwnerIds(excludeRaw, "WORKER_OWNER_EXCLUDE") : undefined,
	};
}

/**
 * A bot with no owner (`owner_user_id IS NULL`) has no id an explicit
 * include-list could ever name, so it always belongs to the exclude-style
 * (catch-all) process — never silently orphaned off of every process.
 */
export function inWorkerScope(ownerUserId: number | null): boolean {
	if (stickyAssignmentEnabled()) {
		const currentWorker = process.env.WORKER_ID?.trim();
		const primaryWorker = process.env.WORKER_PRIMARY_ID?.trim();
		if (!currentWorker || !primaryWorker) {
			throw new Error("balanced-sticky assignment requires WORKER_ID and WORKER_PRIMARY_ID");
		}
		// An owner without an assignment must enter through Primary. The bot
		// creation route persists its final assignment before inserting the bot;
		// every later request then resolves to exactly one process.
		if (ownerUserId === null) return currentWorker === primaryWorker;
		return (assignedWorkerForOwner(ownerUserId) ?? primaryWorker) === currentWorker;
	}
	const { include, exclude } = resolveWorkerScope();
	if (include) return ownerUserId !== null && include.has(ownerUserId);
	if (exclude) return ownerUserId === null || !exclude.has(ownerUserId);
	return true;
}
