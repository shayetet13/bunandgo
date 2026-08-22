import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { WriteBehindOperation } from "./write-behind.ts";
import { SCHEMA_SQL } from "./schema.ts";

type InitMessage = { kind: "init"; dbPath: string };

let db: Database | undefined;
let pending: WriteBehindOperation[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Consecutive flush failures, used only to back off the retry delay — never
 * to give up or drop `pending`. A transient WAL lock clears in well under a
 * second, but a persistent fault (corrupted row, disk full, a file held
 * locked for good) would otherwise retry at the same 100ms as a normal
 * contention wait, indefinitely, for as long as the fault lasts.
 */
let consecutiveFailures = 0;
const BASE_RETRY_DELAY_MS = 100;
const MAX_RETRY_DELAY_MS = 5000;

function initialize(dbPath: string): void {
	if (db) return;
	if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
	db = new Database(dbPath, { create: true });
	// See the matching comment in db/sqlite.ts — this worker's writes race
	// the main thread's on the same WAL file.
	db.exec("PRAGMA busy_timeout = 30000;");
	const journalMode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode;
	if (journalMode?.toLowerCase() !== "wal") db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA synchronous = NORMAL;");
	// This worker opens its own connection, separate from the one the main
	// thread migrates at boot — normally the same on-disk file, so this is
	// otherwise a no-op, but it means a worker that starts against a
	// not-yet-initialized or schema-drifted file (a fresh :memory: instance
	// in tests, in particular) still finds every table it inserts into.
	db.exec(SCHEMA_SQL);
}

function flush(): void {
	flushTimer = undefined;
	if (!db || pending.length === 0) return;
	const batch = pending;
	pending = [];

	const setStmt = db.prepare(
		"INSERT INTO kv (bot_id, key, value_json) VALUES (?, ?, ?) ON CONFLICT(bot_id, key) DO UPDATE SET value_json = excluded.value_json",
	);
	const deleteStmt = db.prepare("DELETE FROM kv WHERE bot_id = ? AND key = ?");
	const clearStmt = db.prepare("DELETE FROM kv WHERE bot_id = ?");
	const latencyStmt = db.prepare(
		`INSERT INTO latency_samples (
			bot_id, ts, surface, target_mid, latency_ms, ok, source, text_preview, inbound_ms, line_created_time,
			line_ms, code_ms, decrypt_ms, match_ms, limiter_ms, routing_ms, protocol_prep_ms, relay_encode_ms, go_prep_ms, relay_and_parse_ms, upstream_calls
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const botEventStmt = db.prepare("INSERT INTO bot_events (bot_id, ts, type, message) VALUES (?, ?, ?, ?)");
	const userActionStmt = db.prepare("INSERT INTO user_actions (user_id, username, ts, action, detail) VALUES (?, ?, ?, ?, ?)");
	const messageInStmt = db.prepare(
		"INSERT INTO messages_in (bot_id, ts, surface, target_mid, text, created_time, from_mid) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	const anomalyStmt = db.prepare("INSERT INTO anomalies (bot_id, ts, kind, severity, chat_mid, detail) VALUES (?, ?, ?, ?, ?, ?)");
	const laneRaceStmt = db.prepare(
		"INSERT INTO lane_race_events (ts, worker_id, origin, lane_id, role, result, rtt_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	const priorityWinStmt = db.prepare(
		"INSERT INTO priority_answers (bot_id, wins) VALUES (?, 1) ON CONFLICT(bot_id) DO UPDATE SET wins = wins + 1",
	);

	try {
		db.transaction(() => {
			for (const operation of batch) {
				switch (operation.kind) {
					case "kv_set":
						setStmt.run(operation.botId, operation.key, operation.valueJson);
						break;
					case "kv_delete":
						deleteStmt.run(operation.botId, operation.key);
						break;
					case "kv_clear":
						clearStmt.run(operation.botId);
						break;
					case "latency": {
						const s = operation.sample;
						const b = s.breakdown;
						latencyStmt.run(
							s.botId,
							s.ts,
							s.surface,
							s.targetMid,
							s.latencyMs,
							s.ok ? 1 : 0,
							s.source,
							s.textPreview,
							b?.inboundMs ?? null,
							s.lineCreatedTime ?? null,
							b?.lineMs ?? null,
							b?.codeMs ?? null,
							b?.decryptMs ?? null,
							b?.matchMs ?? null,
							b?.limiterMs ?? null,
							b?.routingMs ?? null,
							b?.protocolPrepMs ?? null,
							b?.relayEncodeMs ?? null,
							b?.goPrepMs ?? null,
							b?.relayAndParseMs ?? null,
							b?.upstreamCalls ?? null,
						);
						break;
					}
					case "bot_event": {
						const e = operation.entry;
						botEventStmt.run(e.botId, e.ts, e.type, e.message);
						break;
					}
					case "user_action": {
						const e = operation.entry;
						userActionStmt.run(e.userId, e.username, e.ts, e.action, e.detail);
						break;
					}
					case "message_in": {
						const e = operation.entry;
						messageInStmt.run(e.botId, e.ts, e.surface, e.targetMid, e.text, e.createdTime ?? null, e.fromMid ?? null);
						break;
					}
					case "anomaly": {
						const e = operation.entry;
						anomalyStmt.run(e.botId, e.ts, e.kind, e.severity, e.chatMid, e.detail);
						break;
					}
					case "lane_race": {
						const e = operation.entry;
						laneRaceStmt.run(e.ts, e.workerId, e.origin, e.laneId, e.role, e.result, e.rttMs);
						break;
					}
					case "priority_win":
						priorityWinStmt.run(operation.botId);
						break;
				}
			}
		})();
		consecutiveFailures = 0;
	} catch (error) {
		// Preserve ordering and retry. A transient WAL contention must not lose
		// auth tokens or sequence state — pending is never capped or dropped
		// here, only the delay between attempts grows.
		pending = [...batch, ...pending];
		consecutiveFailures++;
		const delay = Math.min(BASE_RETRY_DELAY_MS * 2 ** (consecutiveFailures - 1), MAX_RETRY_DELAY_MS);
		console.error(
			`[sqlite-writer] flush failed (attempt ${consecutiveFailures}, retrying in ${delay}ms): ` +
				`${error instanceof Error ? error.message : String(error)}`,
		);
		flushTimer = setTimeout(flush, delay);
	}
}

function enqueue(operation: WriteBehindOperation): void {
	pending.push(operation);
	if (!flushTimer) flushTimer = setTimeout(flush, 10);
}

globalThis.addEventListener("message", (event: MessageEvent<InitMessage | WriteBehindOperation>) => {
	const message = event.data;
	if (message.kind === "init") {
		initialize(message.dbPath);
		return;
	}
	enqueue(message);
});
