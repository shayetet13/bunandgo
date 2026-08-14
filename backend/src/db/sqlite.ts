import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.ts";
import { SCHEMA_SQL } from "./schema.ts";
import { runMigrations } from "./migrations.ts";

const DB_PATH = config.dbPath;

if (DB_PATH !== ":memory:") mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });
// This connection and the writer worker's (sqlite-writer.worker.ts) each
// open their own handle onto the same WAL file and can write concurrently.
// Without a busy_timeout, one hitting the other mid-write throws SQLITE_BUSY
// immediately as a generic 500 instead of waiting the brief moment a WAL
// writer normally needs to finish. This must be the first PRAGMA: two OS
// workers boot together, and journal_mode itself needs a database lock.
db.exec("PRAGMA busy_timeout = 30000;");
const journalMode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode;
if (journalMode?.toLowerCase() !== "wal") db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");
db.exec(SCHEMA_SQL);
runMigrations(db);
