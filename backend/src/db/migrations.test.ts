import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "./migrations.ts";
import { SCHEMA_SQL } from "./schema.ts";

const opened: Database[] = [];

afterEach(() => {
	for (const database of opened.splice(0)) database.close();
});

describe("database startup migrations", () => {
	test("upgrades a pre-worker lane-race table before creating its worker index", () => {
		const database = new Database(":memory:");
		opened.push(database);
		database.exec(`
			CREATE TABLE lane_race_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts INTEGER NOT NULL,
				origin TEXT NOT NULL,
				lane_id INTEGER NOT NULL,
				role TEXT NOT NULL DEFAULT 'send',
				result TEXT NOT NULL,
				rtt_ms REAL NOT NULL
			)
		`);

		// sqlite.ts deliberately applies the idempotent base schema first and
		// versioned migrations second. The base schema must therefore never
		// reference a column that only the migration can add to an old table.
		database.exec(SCHEMA_SQL);
		runMigrations(database);

		const columns = database
			.query<{ name: string }, []>("PRAGMA table_info(lane_race_events)")
			.all()
			.map((column) => column.name);
		const indexes = database
			.query<{ name: string }, []>("PRAGMA index_list(lane_race_events)")
			.all()
			.map((index) => index.name);

		expect(columns).toContain("worker_id");
		expect(indexes).toContain("idx_lane_race_events_worker");
	});
});
