import type { Database } from "bun:sqlite";

interface Migration {
	id: string;
	up: (db: Database) => void;
}

function hasColumn(db: Database, table: string, column: string): boolean {
	return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

/**
 * Ordered, idempotent schema steps. Each `up()` keeps its own guard
 * (`hasColumn`, `IF NOT EXISTS`, or a naturally idempotent statement) so
 * running it again against a database that already has the change — as this
 * repo's existing `app.db` does, from before this migration runner existed
 * — is a safe no-op. `runMigrations` still records each one so it only ever
 * actually executes once per database going forward.
 */
const migrations: Migration[] = [
	{
		id: "001_bots_owner_user_id",
		up: (db) => {
			if (!hasColumn(db, "bots", "owner_user_id")) {
				db.exec("ALTER TABLE bots ADD COLUMN owner_user_id INTEGER");
			}
		},
	},
	{
		id: "002_auth_sessions_user_id",
		up: (db) => {
			if (!hasColumn(db, "auth_sessions", "user_id")) {
				db.exec("ALTER TABLE auth_sessions ADD COLUMN user_id INTEGER");
			}
		},
	},
	{
		id: "003_ownership_indexes",
		up: (db) => {
			db.exec("CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_user_id)");
			db.exec("CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id)");
		},
	},
	{
		id: "004_rules_surface_scope_backfill",
		up: (db) => {
			// Old per-surface rules ("talk"/"square") were folded into a single
			// "all" scope; updating rows that are already "all" is a no-op.
			db.exec("UPDATE rules SET surface = 'all' WHERE surface IN ('talk', 'square')");
		},
	},
	{
		id: "005_chats_enabled_column",
		up: (db) => {
			// Defaults every existing chat to disabled — auto-reply must be
			// opted into per chat from now on rather than firing in every
			// group/OpenChat the bot happens to have joined.
			if (!hasColumn(db, "chats", "enabled")) {
				db.exec("ALTER TABLE chats ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0");
			}
		},
	},
	{
		id: "006_chats_admin_only_column",
		up: (db) => {
			// OpenChat-only gate: when set, the bot answers matching keywords
			// solely from members LINE reports as ADMIN/CO_ADMIN in that room
			// (see bot/square-roles.ts). Meaningless for "talk" rows — LINE's
			// classic group protocol has no admin concept to check against —
			// so it simply stays 0 there and the policy check skips it.
			if (!hasColumn(db, "chats", "admin_only")) {
				db.exec("ALTER TABLE chats ADD COLUMN admin_only INTEGER NOT NULL DEFAULT 0");
			}
		},
	},
	{
		id: "007_messages_in_table",
		up: (db) => {
			// Durable half of the live feed. `SCHEMA_SQL` already creates this
			// for a fresh database; the migration is what gets it onto the
			// existing production file, which predates the table.
			db.exec(`
				CREATE TABLE IF NOT EXISTS messages_in (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					bot_id INTEGER NOT NULL,
					ts INTEGER NOT NULL,
					surface TEXT NOT NULL,
					target_mid TEXT,
					text TEXT
				)
			`);
			db.exec("CREATE INDEX IF NOT EXISTS idx_messages_in_bot_ts ON messages_in(bot_id, ts)");
		},
	},
	{
		id: "008_anomalies_table",
		up: (db) => {
			// Same story as messages_in: SCHEMA_SQL creates it for a fresh
			// database, this is what puts it on the existing production file.
			db.exec(`
				CREATE TABLE IF NOT EXISTS anomalies (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					bot_id INTEGER,
					ts INTEGER NOT NULL,
					kind TEXT NOT NULL,
					severity TEXT NOT NULL,
					chat_mid TEXT,
					detail TEXT
				)
			`);
			db.exec("CREATE INDEX IF NOT EXISTS idx_anomalies_ts ON anomalies(ts)");
			db.exec("CREATE INDEX IF NOT EXISTS idx_anomalies_bot_ts ON anomalies(bot_id, ts)");
		},
	},
	{
		id: "009_latency_inbound_ms",
		up: (db) => {
			// How late LINE handed us the trigger, kept per sample so the
			// distribution can be compared across surfaces and over time —
			// a single live reading on the dashboard cannot answer "is our
			// receive path slower than theirs, and has it always been".
			// Nullable: manual test sends have no inbound message.
			if (!hasColumn(db, "latency_samples", "inbound_ms")) {
				db.exec("ALTER TABLE latency_samples ADD COLUMN inbound_ms REAL");
			}
		},
	},
	{
		id: "010_line_created_time",
		up: (db) => {
			// LINE stamps every message with the moment its own server accepted
			// it. Storing that for messages we receive AND for replies we send
			// makes a rival's speed measurable on the same clock as ours: the
			// gap between a trigger's stamp and a reply's stamp is that bot's
			// true end-to-end time, whoever sent it. Without this, every
			// comparison runs on two different clocks and proves nothing.
			if (!hasColumn(db, "messages_in", "created_time")) {
				db.exec("ALTER TABLE messages_in ADD COLUMN created_time INTEGER");
			}
			if (!hasColumn(db, "latency_samples", "line_created_time")) {
				db.exec("ALTER TABLE latency_samples ADD COLUMN line_created_time INTEGER");
			}
		},
	},
	{
		id: "011_messages_in_from_mid",
		up: (db) => {
			// Who sent it. Without this, "a rival bot answered the trigger"
			// and "the same person typed again" are the same shape — a
			// message following another message — and nothing built on
			// message order alone can tell them apart.
			if (!hasColumn(db, "messages_in", "from_mid")) {
				db.exec("ALTER TABLE messages_in ADD COLUMN from_mid TEXT");
			}
		},
	},
	{
		id: "012_bots_slot",
		up: (db) => {
			// Display number ("bot1", "bot2", ...) shown to users instead of
			// the raw autoincrement id, which never gets reused once a bot is
			// deleted. Backfilled here in creation order for whatever bots
			// already exist; every bot created afterward gets one from
			// allocateBotSlot() (see bot/bots.ts) at insert time.
			if (!hasColumn(db, "bots", "slot")) {
				db.exec("ALTER TABLE bots ADD COLUMN slot INTEGER");
			}
			const unslotted = db.query<{ id: number }, []>(
				"SELECT id FROM bots WHERE slot IS NULL ORDER BY created_at ASC, id ASC",
			).all();
			const setSlot = db.prepare<null, [number, number]>("UPDATE bots SET slot = ? WHERE id = ?");
			const taken = new Set(
				db.query<{ slot: number | null }, []>("SELECT slot FROM bots WHERE slot IS NOT NULL").all().map((r) => r.slot!),
			);
			let next = 1;
			for (const { id } of unslotted) {
				while (taken.has(next)) next++;
				setSlot.run(next, id);
				taken.add(next);
			}
		},
	},
	{
		id: "013_scheduled_posts_table",
		up: (db) => {
			// Same story as messages_in/anomalies: SCHEMA_SQL creates it for a
			// fresh database, this is what puts it on the existing production file.
			db.exec(`
				CREATE TABLE IF NOT EXISTS scheduled_posts (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					bot_id INTEGER NOT NULL,
					surface TEXT NOT NULL,
					target_mid TEXT NOT NULL,
					text TEXT NOT NULL,
					run_at INTEGER NOT NULL,
					enabled INTEGER NOT NULL DEFAULT 1,
					sent_at INTEGER,
					created_at INTEGER NOT NULL
				)
			`);
			db.exec("CREATE INDEX IF NOT EXISTS idx_scheduled_posts_bot ON scheduled_posts(bot_id)");
			db.exec("CREATE INDEX IF NOT EXISTS idx_scheduled_posts_run_at ON scheduled_posts(run_at)");
		},
	},
	{
		// The per-bot 3.45-minute send cooldown is gone (see rate-limiter.ts),
		// so its setting rows are now unread state that would silently come
		// back to life if anything ever reused the key name.
		id: "014_drop_cooldown_setting",
		up: (db) => {
			db.exec("DELETE FROM kv WHERE key = 'cooldownEnabled'");
		},
	},
	{
		// How many bots this user may create for themselves. Starts at the
		// old hard-coded self-service limit so nobody's existing allowance
		// changes on deploy; an admin raises it per user from there.
		id: "015_users_bot_quota",
		up: (db) => {
			if (!hasColumn(db, "users", "bot_quota")) {
				db.exec("ALTER TABLE users ADD COLUMN bot_quota INTEGER NOT NULL DEFAULT 1");
			}
		},
	},
	{
		// Which specific admins a room answers, when the room's admin-only
		// switch is on. No rows for a chat means "any admin", which is what
		// that switch meant on its own before this existed — so every room
		// that already had it on keeps behaving identically.
		id: "016_chat_admin_allowlist",
		up: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS chat_admin_allowlist (
					bot_id INTEGER NOT NULL,
					mid TEXT NOT NULL,
					member_mid TEXT NOT NULL,
					PRIMARY KEY (bot_id, mid, member_mid)
				)
			`);
		},
	},
	{
		// Marks which of an owner's several bots in one OpenChat is the one
		// whose account actually sends the reply — the rest still detect at
		// full speed but hand the send off (see bot/primary-bot.ts). Default
		// 0 on every existing row: with nothing set, the earliest-joined
		// sibling is used, so this is a pure opt-in and no room's answering
		// bot changes on deploy.
		id: "017_chats_is_primary_column",
		up: (db) => {
			if (!hasColumn(db, "chats", "is_primary")) {
				db.exec("ALTER TABLE chats ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0");
			}
		},
	},
	{
		id: "018_lane_race_events",
		up: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS lane_race_events (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					ts INTEGER NOT NULL,
					origin TEXT NOT NULL,
					lane_id INTEGER NOT NULL,
					result TEXT NOT NULL,
					rtt_ms REAL NOT NULL
				)
			`);
			db.exec("CREATE INDEX IF NOT EXISTS idx_lane_race_events_ts ON lane_race_events(ts)");
			db.exec("CREATE INDEX IF NOT EXISTS idx_lane_race_events_lane ON lane_race_events(origin, lane_id, ts)");
		},
	},
	{
		// Version 1 only scored the two send-reserved lanes. Poll lanes were
		// alive but appeared as scoreless HOT lanes in the dashboard. Keep the
		// old rows as send scores, then let poll samples earn their own points.
		id: "019_lane_race_role",
		up: (db) => {
			if (!hasColumn(db, "lane_race_events", "role")) {
				db.exec("ALTER TABLE lane_race_events ADD COLUMN role TEXT NOT NULL DEFAULT 'send'");
			}
			db.exec("CREATE INDEX IF NOT EXISTS idx_lane_race_events_role ON lane_race_events(origin, lane_id, role, ts)");
		},
	},
	{
		// Was live only on the console/dashboard, gone the moment the process
		// moved on — this is what let square (no E2EE) and talk (E2EE) get
		// silently averaged into one misleading protocolPrepMs. Persisting it
		// lets the two be told apart after the fact, from real traffic.
		id: "020_latency_samples_breakdown",
		up: (db) => {
			for (
				const column of [
					"line_ms", "code_ms", "decrypt_ms", "match_ms", "limiter_ms",
					"protocol_prep_ms", "relay_encode_ms", "go_prep_ms", "relay_and_parse_ms",
				]
			) {
				if (!hasColumn(db, "latency_samples", column)) {
					db.exec(`ALTER TABLE latency_samples ADD COLUMN ${column} REAL`);
				}
			}
			if (!hasColumn(db, "latency_samples", "upstream_calls")) {
				db.exec("ALTER TABLE latency_samples ADD COLUMN upstream_calls INTEGER");
			}
		},
	},
	{
		// The live feed replays the newest rows for one bot ordered by id.
		// The older time indexes filter correctly, but make SQLite sort into a
		// temporary B-tree (and latency_samples previously scanned in full).
		// These indexes keep a dashboard refresh bounded as the daily feed grows.
		id: "021_live_feed_bot_id_indexes",
		up: (db) => {
			db.exec("CREATE INDEX IF NOT EXISTS idx_messages_in_bot_id ON messages_in(bot_id, id DESC)");
			db.exec("CREATE INDEX IF NOT EXISTS idx_latency_samples_bot_id ON latency_samples(bot_id, id DESC)");
		},
	},
	{
		id: "022_shared_start_confirmations",
		up: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS start_confirmations (
					token TEXT PRIMARY KEY,
					bot_id INTEGER NOT NULL,
					status TEXT NOT NULL,
					created_at INTEGER NOT NULL
				)
			`);
			db.exec("CREATE INDEX IF NOT EXISTS idx_start_confirmations_bot ON start_confirmations(bot_id)");
			db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_start_confirmations_pending_bot ON start_confirmations(bot_id) WHERE status = 'pending'");
		},
	},
	{
		id: "023_lane_race_worker_identity",
		up: (db) => {
			if (!hasColumn(db, "lane_race_events", "worker_id")) {
				db.exec("ALTER TABLE lane_race_events ADD COLUMN worker_id TEXT NOT NULL DEFAULT 'legacy'");
			}
			db.exec("CREATE INDEX IF NOT EXISTS idx_lane_race_events_worker ON lane_race_events(worker_id, origin, lane_id, role, ts)");
		},
	},
	{
		id: "024_latency_routing_phase",
		up: (db) => {
			if (!hasColumn(db, "latency_samples", "routing_ms")) {
				db.exec("ALTER TABLE latency_samples ADD COLUMN routing_ms REAL");
			}
		},
	},
	{
		// Web sessions used to be valid for 400 days and had no server-side
		// inactivity cutoff. Keep this nullable on upgraded databases so an old
		// process finishing a rolling restart can still insert a session. Deleting
		// the old rows deliberately invalidates every pre-hardening token once.
		id: "025_auth_session_last_seen",
		up: (db) => {
			if (!hasColumn(db, "auth_sessions", "last_seen_at")) {
				db.exec("ALTER TABLE auth_sessions ADD COLUMN last_seen_at INTEGER");
			}
			db.exec("DELETE FROM auth_sessions");
		},
	},
	{
		id: "026_bots_locked_line_mid",
		up: (db) => {
			if (!hasColumn(db, "bots", "locked_line_mid")) {
				db.exec("ALTER TABLE bots ADD COLUMN locked_line_mid TEXT");
			}
		},
	},
	{
		id: "027_users_exempt_id_lock",
		up: (db) => {
			if (!hasColumn(db, "users", "exempt_id_lock")) {
				db.exec("ALTER TABLE users ADD COLUMN exempt_id_lock INTEGER NOT NULL DEFAULT 0");
			}
		},
	},
	{
		id: "028_bots_locked_line_display_name",
		up: (db) => {
			if (!hasColumn(db, "bots", "locked_line_display_name")) {
				db.exec("ALTER TABLE bots ADD COLUMN locked_line_display_name TEXT");
			}
		},
	},
	{
		// A priority bot's answers toward its quota (bot/priority-answerer.ts)
		// — one global count per bot across every room combined. Same story as
		// messages_in/anomalies: SCHEMA_SQL creates it for a fresh database,
		// this puts it on the existing production file.
		id: "029_priority_answers_table",
		up: (db) => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS priority_answers (
					bot_id INTEGER PRIMARY KEY,
					wins INTEGER NOT NULL DEFAULT 0
				)
			`);
		},
	},
];

/**
 * Applies every pending migration and returns the ids that were actually
 * newly applied this run (as opposed to already recorded from a previous
 * boot) — callers use this to gate one-off follow-up work that should run
 * exactly once, right when a specific migration first lands. See
 * sweepLegacyIdLockNames() in bot/session-manager.ts for the current use.
 */
export function runMigrations(db: Database): string[] {
	// One immediate transaction serializes schema work across the primary and
	// shard processes that boot together against the same SQLite file. The old
	// per-migration transactions let both processes observe a migration as
	// missing, then race the same ALTER/INSERT. busy_timeout on the connection
	// makes the second process wait here and re-read the applied set afterward.
	const newlyApplied: string[] = [];
	const applyAll = db.transaction(() => {
		db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
		const applied = new Set(db.query<{ id: string }, []>("SELECT id FROM schema_migrations").all().map((row) => row.id));
		const markApplied = db.prepare<null, [string, number]>("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
		for (const migration of migrations) {
			if (applied.has(migration.id)) continue;
			migration.up(db);
			markApplied.run(migration.id, Date.now());
			newlyApplied.push(migration.id);
		}
	});
	applyAll.immediate();
	return newlyApplied;
}
