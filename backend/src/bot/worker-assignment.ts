import { db } from "../db/sqlite.ts";

export const STICKY_ASSIGNMENT_MODE = "balanced-sticky";

interface AssignmentRow {
	owner_user_id: number;
	worker_id: string;
}

interface WorkerCountRow {
	worker_id: string;
	owners: number;
}

const getAssignmentStmt = db.prepare<AssignmentRow, [number]>(
	"SELECT owner_user_id, worker_id FROM owner_worker_assignments WHERE owner_user_id = ?",
);
const listAssignmentsStmt = db.prepare<AssignmentRow, []>(
	"SELECT owner_user_id, worker_id FROM owner_worker_assignments ORDER BY owner_user_id",
);
const countAssignmentsStmt = db.prepare<WorkerCountRow, []>(
	"SELECT worker_id, COUNT(*) AS owners FROM owner_worker_assignments GROUP BY worker_id",
);
const insertAssignmentStmt = db.prepare<null, [number, string, number]>(
	"INSERT INTO owner_worker_assignments (owner_user_id, worker_id, assigned_at) VALUES (?, ?, ?)",
);

export function stickyAssignmentEnabled(): boolean {
	return process.env.WORKER_ASSIGNMENT_MODE?.trim() === STICKY_ASSIGNMENT_MODE;
}

export function parseAssignmentWorkers(raw = process.env.WORKER_ASSIGNMENT_WORKERS): string[] {
	const workers = (raw ?? "")
		.split(",")
		.map((worker) => worker.trim())
		.filter(Boolean);
	if (workers.length < 2) throw new Error("WORKER_ASSIGNMENT_WORKERS must contain at least two worker ids");
	if (new Set(workers).size !== workers.length) {
		throw new Error("WORKER_ASSIGNMENT_WORKERS cannot contain duplicate worker ids");
	}
	return workers;
}

export function assignedWorkerForOwner(ownerUserId: number): string | undefined {
	return getAssignmentStmt.get(ownerUserId)?.worker_id;
}

export function listOwnerWorkerAssignments(): Map<number, string> {
	return new Map(listAssignmentsStmt.all().map((row) => [row.owner_user_id, row.worker_id]));
}

/**
 * Assign once under an IMMEDIATE SQLite transaction. The shared database is
 * opened by both OS workers, so serializing the count+insert prevents two
 * simultaneous first-bot requests from choosing from the same stale counts.
 * Array order is the deterministic tie-breaker: Primary receives the first
 * owner, Shard B the second, and the difference never exceeds one.
 */
const assignOwnerTxn = db.transaction((ownerUserId: number, workers: string[]): string => {
	const existing = getAssignmentStmt.get(ownerUserId)?.worker_id;
	if (existing) return existing;
	const counts = new Map(workers.map((worker) => [worker, 0]));
	for (const row of countAssignmentsStmt.all()) {
		if (counts.has(row.worker_id)) counts.set(row.worker_id, row.owners);
	}
	let selected = workers[0]!;
	for (const worker of workers.slice(1)) {
		if (counts.get(worker)! < counts.get(selected)!) selected = worker;
	}
	insertAssignmentStmt.run(ownerUserId, selected, Date.now());
	return selected;
});

export function ensureOwnerWorkerAssignment(ownerUserId: number): string {
	if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) {
		throw new Error(`invalid owner id for worker assignment: ${ownerUserId}`);
	}
	if (!stickyAssignmentEnabled()) return process.env.WORKER_ID?.trim() || "standalone";
	return assignOwnerTxn.immediate(ownerUserId, parseAssignmentWorkers());
}
