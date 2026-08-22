import { EventEmitter } from "node:events";

/**
 * In-process, admin-only security notifications. The durable audit row and
 * out-of-band alert remain the source of truth; this emitter only gives an
 * already-open dashboard an immediate heads-up without polling the database.
 */
export interface SecurityAlertEvent {
	kind: string;
	severity: "medium" | "high" | "critical";
	ts: number;
	ip: string;
	method: string;
	path: string;
	count: number;
	userAgent: string;
	detail: string;
}

export const securityEvents = new EventEmitter();
