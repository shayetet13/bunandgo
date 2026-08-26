export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	username TEXT NOT NULL UNIQUE COLLATE NOCASE,
	password_hash TEXT NOT NULL,
	role TEXT NOT NULL DEFAULT 'user',
	active INTEGER NOT NULL DEFAULT 1,
	-- How many bots this user may create for themselves. Only an admin can
	-- raise it (see auth/users.ts setUserBotQuota); admins are uncapped.
	bot_quota INTEGER NOT NULL DEFAULT 1,
	-- Lets an admin mark a "test" account exempt from the one-LINE-account-
	-- per-bot lock below — see bot/bots.ts isIdLockExempt().
	exempt_id_lock INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
);

-- slot is the stable, human-facing label ("bot1", "bot2", ...). It is kept
-- separate from display_order so dragging a card never renames the bot.
CREATE TABLE IF NOT EXISTS bots (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	slot INTEGER NOT NULL,
	display_order INTEGER NOT NULL,
	device TEXT NOT NULL DEFAULT 'DESKTOPWIN',
	status TEXT NOT NULL DEFAULT 'offline',
	owner_user_id INTEGER,
	-- The LINE account (profile.mid) that first logged into this bot slot.
	-- NULL until the first successful login; every login after that must
	-- match, unless the owner is exempt — see bot/bots.ts evaluateIdLock().
	locked_line_mid TEXT,
	-- Display name captured together with locked_line_mid at first login —
	-- a same-mid login with a different name is flagged too, since a
	-- changed name can mean the account was handed to someone else. NULL
	-- for bots locked before this column existed, until the deploy-time
	-- sweep (or, as a fallback, their next successful login) backfills it.
	locked_line_display_name TEXT,
	created_at INTEGER NOT NULL
);

-- One durable runtime home per owner. The assignment is created once when
-- the owner's first bot is created and is never changed by login, reconnect,
-- restart, or lane health. Keeping this separate from bots also preserves the
-- same worker when an owner deletes and recreates a bot.
CREATE TABLE IF NOT EXISTS owner_worker_assignments (
	owner_user_id INTEGER PRIMARY KEY,
	worker_id TEXT NOT NULL,
	assigned_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_owner_worker_assignments_worker
	ON owner_worker_assignments(worker_id, owner_user_id);

CREATE TABLE IF NOT EXISTS kv (
	bot_id INTEGER NOT NULL,
	key TEXT NOT NULL,
	value_json TEXT NOT NULL,
	PRIMARY KEY (bot_id, key)
);

-- inbound_ms is how late LINE handed us the trigger, before any of the
-- other timings started. Nullable: a manual test send has no inbound
-- message to be late. See bot/inbound-delay.ts.
CREATE TABLE IF NOT EXISTS latency_samples (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	bot_id INTEGER,
	ts INTEGER NOT NULL,
	surface TEXT NOT NULL,
	target_mid TEXT,
	latency_ms REAL NOT NULL,
	ok INTEGER NOT NULL,
	source TEXT NOT NULL,
	text_preview TEXT,
	inbound_ms REAL,
	line_created_time INTEGER,
	-- Per-phase breakdown (see metrics/latency.ts LatencyBreakdown), stored so
	-- surfaces with very different cost profiles (square: no E2EE vs talk:
	-- E2EE) can be told apart after the fact instead of only ever seen live
	-- on the console/dashboard and then discarded.
	line_ms REAL,
	code_ms REAL,
	decrypt_ms REAL,
	match_ms REAL,
	limiter_ms REAL,
	routing_ms REAL,
	protocol_prep_ms REAL,
	relay_encode_ms REAL,
	go_prep_ms REAL,
	relay_and_parse_ms REAL,
	upstream_calls INTEGER
);
CREATE INDEX IF NOT EXISTS idx_latency_samples_ts ON latency_samples(ts);
-- The live-feed replay asks for one bot's newest replies by id.  The time
-- index above cannot satisfy that ordering, so without this SQLite scans the
-- whole table as traffic accumulates during the day.
CREATE INDEX IF NOT EXISTS idx_latency_samples_bot_id ON latency_samples(bot_id, id DESC);

-- One post-send result for every HTTP/2 lane race. Kept separate from bot
-- latency so the dashboard can compare routes without touching the reply path.
CREATE TABLE IF NOT EXISTS lane_race_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ts INTEGER NOT NULL,
	worker_id TEXT NOT NULL DEFAULT 'legacy',
	origin TEXT NOT NULL,
	lane_id INTEGER NOT NULL,
	role TEXT NOT NULL DEFAULT 'send',
	result TEXT NOT NULL,
	rtt_ms REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lane_race_events_ts ON lane_race_events(ts);
CREATE INDEX IF NOT EXISTS idx_lane_race_events_lane ON lane_race_events(origin, lane_id, ts);

CREATE TABLE IF NOT EXISTS rules (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	bot_id INTEGER NOT NULL,
	surface TEXT NOT NULL,
	match_type TEXT NOT NULL,
	match_value TEXT NOT NULL,
	reply_text TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	priority INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rules_bot ON rules(bot_id);

CREATE TABLE IF NOT EXISTS chats (
	bot_id INTEGER NOT NULL,
	mid TEXT NOT NULL,
	surface TEXT NOT NULL,
	name TEXT,
	joined_at INTEGER NOT NULL,
	PRIMARY KEY (bot_id, mid)
);

-- Which specific ADMIN/CO_ADMIN members a room answers while its admin_only
-- switch is on. No rows for a chat means "any admin" — see chat-access.ts.
CREATE TABLE IF NOT EXISTS chat_admin_allowlist (
	bot_id INTEGER NOT NULL,
	mid TEXT NOT NULL,
	member_mid TEXT NOT NULL,
	PRIMARY KEY (bot_id, mid, member_mid)
);

CREATE TABLE IF NOT EXISTS auth_sessions (
	token_hash TEXT PRIMARY KEY,
	user_id INTEGER,
	created_at INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	bot_id INTEGER,
	ts INTEGER NOT NULL,
	type TEXT NOT NULL,
	message TEXT
);
CREATE INDEX IF NOT EXISTS idx_bot_events_bot_ts ON bot_events(bot_id, ts);

CREATE TABLE IF NOT EXISTS user_actions (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER,
	username TEXT NOT NULL,
	ts INTEGER NOT NULL,
	action TEXT NOT NULL,
	detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_actions_ts ON user_actions(ts);

-- Incoming messages, the half of the live feed that had no home before.
-- Outgoing replies were already durable in latency_samples, so the feed lost
-- only one side of the conversation on a refresh; it now survives both that
-- and a restart. Written through the same write-behind worker as everything
-- else on the reply path, never inline.
-- created_time is LINE's own stamp for when its server accepted the
-- message. It is the only clock every participant shares, so it is what
-- makes one bot's speed comparable to another's — including a rival's,
-- whose replies arrive here as ordinary incoming messages.
-- from_mid is who sent it. Without it, "a rival bot answered" and "the
-- same person typed again" are the same shape — one message following
-- another — and nothing built on message order alone can tell them apart.
CREATE TABLE IF NOT EXISTS messages_in (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	bot_id INTEGER NOT NULL,
	ts INTEGER NOT NULL,
	surface TEXT NOT NULL,
	target_mid TEXT,
	text TEXT,
	created_time INTEGER,
	from_mid TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_in_bot_ts ON messages_in(bot_id, ts);
-- Matches the live-feed replay's WHERE bot_id = ? ORDER BY id DESC query.
CREATE INDEX IF NOT EXISTS idx_messages_in_bot_id ON messages_in(bot_id, id DESC);

-- Anything that interfered with a reply the bot should have made: a message
-- of ours deleted, a send LINE accepted but did not show, our own throttle
-- swallowing an answer, a room we can no longer read. Kept apart from
-- bot_events (lifecycle: started/online/stopped) because these are the rows
-- worth opening when the bot "did not answer" and nobody knows why — mixing
-- them into the lifecycle feed is what made the last round guesswork.
CREATE TABLE IF NOT EXISTS anomalies (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	bot_id INTEGER,
	ts INTEGER NOT NULL,
	kind TEXT NOT NULL,
	severity TEXT NOT NULL,
	chat_mid TEXT,
	detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_anomalies_ts ON anomalies(ts);
CREATE INDEX IF NOT EXISTS idx_anomalies_bot_ts ON anomalies(bot_id, ts);

-- One-shot posts fired by wall-clock time instead of a keyword — the "no
-- keyword" rule: a bot that must speak first the instant a clock hits an
-- exact date+time (Asia/Bangkok), not in reaction to anything anyone typed.
-- run_at is epoch ms; sent_at stays NULL until the send actually goes out,
-- so a restart can tell a still-pending post from one it already fired.
-- See bot/scheduled-posts.ts (data) and bot/session-manager.ts (the timer
-- that fires it at the exact millisecond rather than polling for it).
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
);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_bot ON scheduled_posts(bot_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_run_at ON scheduled_posts(run_at);

-- Shared by the public control plane and runtime shards so a confirmation
-- link does not depend on which process receives the scanned request.
CREATE TABLE IF NOT EXISTS start_confirmations (
	token TEXT PRIMARY KEY,
	bot_id INTEGER NOT NULL,
	status TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_start_confirmations_bot ON start_confirmations(bot_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_start_confirmations_pending_bot
	ON start_confirmations(bot_id) WHERE status = 'pending';

-- A priority bot's answers toward its quota (priority-answerer.ts) — one
-- global count per bot across every room combined, lifetime, not per day
-- or per room. Durable so a restart never hands out a fresh quota it
-- already used up.
CREATE TABLE IF NOT EXISTS priority_answers (
	bot_id INTEGER PRIMARY KEY,
	wins INTEGER NOT NULL DEFAULT 0
);

-- Admin-authored notices shown on every signed-in user's console (see
-- announcements/announcements.ts). Deliberately not bot- or owner-scoped —
-- one shared list, same as app_meta settings, visible from every worker.
CREATE TABLE IF NOT EXISTS announcements (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	created_by_user_id INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	is_modal_alert INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_announcements_created_at ON announcements(created_at DESC);

-- Periodic CPU/RAM snapshots for all three physical machines (server1 edge,
-- server2 this process, server3 lane relay) — see monitoring/server-load-history.ts.
-- Sampled far coarser than the live 5s in-process monitor (system-load.ts);
-- this table exists only to draw a trend, not to drive alerting.
CREATE TABLE IF NOT EXISTS server_load_samples (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	server_id TEXT NOT NULL,
	ts INTEGER NOT NULL,
	cpu_percent REAL NOT NULL,
	memory_percent REAL NOT NULL,
	capacity_percent REAL NOT NULL,
	event_loop_lag_ms REAL
);
CREATE INDEX IF NOT EXISTS idx_server_load_samples_server_ts ON server_load_samples(server_id, ts);
`;

export type Surface = "talk" | "square" | "oa";
export type RuleSurface = Surface | "all";
export type BotStatus = "offline" | "connecting" | "online";
export type UserRole = "admin" | "user";

export interface UserRow {
	id: number;
	username: string;
	password_hash: string;
	role: UserRole;
	active: number;
	bot_quota: number;
	exempt_id_lock: number;
	created_at: number;
}

export interface BotRow {
	id: number;
	name: string;
	slot: number;
	display_order: number;
	device: string;
	status: BotStatus;
	owner_user_id: number | null;
	locked_line_mid: string | null;
	locked_line_display_name: string | null;
	created_at: number;
}

export interface LatencySampleRow {
	id: number;
	bot_id: number | null;
	ts: number;
	surface: Surface;
	target_mid: string | null;
	latency_ms: number;
	ok: number;
	source: "test" | "auto";
	text_preview: string | null;
	inbound_ms: number | null;
	line_created_time: number | null;
	line_ms: number | null;
	code_ms: number | null;
	decrypt_ms: number | null;
	match_ms: number | null;
	limiter_ms: number | null;
	routing_ms: number | null;
	protocol_prep_ms: number | null;
	relay_encode_ms: number | null;
	go_prep_ms: number | null;
	relay_and_parse_ms: number | null;
	upstream_calls: number | null;
}

export interface RuleRow {
	id: number;
	bot_id: number;
	surface: RuleSurface;
	match_type: "equals" | "startsWith" | "regex" | "containsAny";
	match_value: string;
	reply_text: string;
	enabled: number;
	priority: number;
	created_at: number;
}

export interface ChatRow {
	bot_id: number;
	mid: string;
	surface: Surface;
	name: string | null;
	joined_at: number;
	enabled: number;
	admin_only: number;
	is_primary: number;
}

export interface BotEventRow {
	id: number;
	bot_id: number | null;
	ts: number;
	type: string;
	message: string | null;
}

export interface UserActionRow {
	id: number;
	user_id: number | null;
	username: string;
	ts: number;
	action: string;
	detail: string | null;
}

export interface MessageInRow {
	id: number;
	bot_id: number;
	ts: number;
	surface: Surface;
	target_mid: string | null;
	text: string | null;
	created_time: number | null;
	from_mid: string | null;
}

export type AnomalySeverity = "info" | "warn" | "critical";

export interface AnomalyRow {
	id: number;
	bot_id: number | null;
	ts: number;
	kind: string;
	severity: AnomalySeverity;
	chat_mid: string | null;
	detail: string | null;
}

export interface ScheduledPostRow {
	id: number;
	bot_id: number;
	surface: Surface;
	target_mid: string;
	text: string;
	run_at: number;
	enabled: number;
	sent_at: number | null;
	created_at: number;
}

export interface StartConfirmationRow {
	token: string;
	bot_id: number;
	status: "pending" | "accepted" | "declined";
	created_at: number;
}

export interface AnnouncementRow {
	id: number;
	title: string;
	body: string;
	created_by_user_id: number | null;
	created_at: number;
	updated_at: number;
	is_modal_alert: number;
}

export type MonitoredServerId = "server1" | "server2" | "server3";

export interface ServerLoadSampleRow {
	id: number;
	server_id: MonitoredServerId;
	ts: number;
	cpu_percent: number;
	memory_percent: number;
	capacity_percent: number;
	event_loop_lag_ms: number | null;
}
