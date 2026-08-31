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

	test("drops the retired priority_answers table, on an upgraded database and a fresh one alike", () => {
		const upgraded = new Database(":memory:");
		opened.push(upgraded);
		// An existing production file: the table is already there, with rows.
		upgraded.exec("CREATE TABLE priority_answers (bot_id INTEGER PRIMARY KEY, wins INTEGER NOT NULL DEFAULT 0)");
		upgraded.exec("INSERT INTO priority_answers (bot_id, wins) VALUES (1, 2)");
		upgraded.exec(SCHEMA_SQL);
		runMigrations(upgraded);

		const fresh = new Database(":memory:");
		opened.push(fresh);
		fresh.exec(SCHEMA_SQL);
		runMigrations(fresh);

		// The name-based priority rule is gone; both paths must converge on a
		// schema that no longer carries its counters.
		for (const database of [upgraded, fresh]) {
			const tables = database
				.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
				.all()
				.map((row) => row.name);
			expect(tables).not.toContain("priority_answers");
		}
	});

	test("returns the ids it newly applied, and nothing on a second run against the same database", () => {
		const database = new Database(":memory:");
		opened.push(database);
		database.exec(SCHEMA_SQL);

		const firstRun = runMigrations(database);
		expect(firstRun).toContain("028_bots_locked_line_display_name");

		const secondRun = runMigrations(database);
		expect(secondRun).toEqual([]);
	});

	test("adds card order to an existing bots table without changing stable slots", () => {
		const database = new Database(":memory:");
		opened.push(database);
		database.exec(`
			CREATE TABLE bots (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL,
				slot INTEGER NOT NULL,
				device TEXT NOT NULL DEFAULT 'DESKTOPWIN',
				status TEXT NOT NULL DEFAULT 'offline',
				created_at INTEGER NOT NULL
			);
			INSERT INTO bots (name, slot, created_at) VALUES ('second', 2, 2), ('first', 1, 1);
		`);

		database.exec(SCHEMA_SQL);
		runMigrations(database);

		const rows = database
			.query<{ slot: number; display_order: number }, []>("SELECT slot, display_order FROM bots ORDER BY display_order")
			.all();
		expect(rows).toEqual([
			{ slot: 1, display_order: 1 },
			{ slot: 2, display_order: 2 },
		]);
	});
});
