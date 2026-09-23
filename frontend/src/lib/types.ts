export type Surface = "talk" | "square" | "oa";
export type RuleSurface = Surface | "all";
export type BotStatus = "offline" | "connecting" | "online";
/**
 * Where inside "connecting" a bot is. "awaiting_scan" is the only phase the
 * user can act on — once LINE accepts the scan the code is spent, and the
 * rest of the wait ("preparing") is the backend building the session.
 */
export type LoginPhase = "resuming" | "awaiting_scan" | "preparing";
export type UserRole = "admin" | "user";

export interface Bot {
	id: number;
	name: string;
	slot: number;
	device: string;
	status: BotStatus;
	ownerUserId: number | null;
	allowOwnerTesting: boolean;
	/** Past the owner's quota — cannot be started until the quota is raised. */
	overQuota: boolean;
	/** The LINE account locked to this bot slot, or null before its first login. */
	lockedLineMid: string | null;
	/** Display name locked alongside lockedLineMid at first login — null until reverified for a bot locked before this field existed. */
	lockedLineDisplayName: string | null;
	createdAt: number;
}

export interface ManagedUser {
	id: number;
	username: string;
	role: UserRole;
	active: boolean;
	/** How many bots this user may create for themselves. Admins are uncapped. */
	botQuota: number;
	/** Excused from the one-LINE-account-per-bot lock — a test account that legitimately swaps LINE accounts. */
	exemptIdLock: boolean;
	createdAt: number;
	botCount: number;
}

/** The ceiling an admin may raise a user to — mirrors MAX_BOT_QUOTA on the server. */
export const MAX_BOT_QUOTA = 5;

/** What a quota change would do, fetched before it is applied. */
export interface QuotaPreview {
	currentQuota: number;
	nextQuota: number;
	botCount: number;
	willStop: Array<{ id: number; name: string; status: BotStatus }>;
}

export interface LatencySample {
	botId: number;
	ts: number;
	surface: Surface;
	targetMid: string | null;
	latencyMs: number;
	ok: boolean;
	source: "test" | "auto";
	textPreview: string | null;
	lineCreatedTime?: number;
	/** LINE's own stamp for the trigger this reply answers — undefined for a manual test send. */
	triggerCreatedTime?: number;
	breakdown?: LatencyBreakdown;
}

export interface LatencyBreakdown {
	lineMs: number;
	codeMs: number;
	/**
	 * How late LINE delivered the trigger to us, before our own clock
	 * started. Absent when there was no inbound message to be late.
	 */
	inboundMs?: number;
	decryptMs: number;
	matchMs: number;
	limiterMs: number;
	routingMs?: number;
	protocolPrepMs: number;
	relayEncodeMs: number;
	goPrepMs: number;
	relayAndParseMs: number;
	upstreamCalls: number;
}

export const LATENCY_THRESHOLDS_MS = {
	target: 40,
	p95Limit: 50,
	p99Limit: 60,
	incident: 80,
	severe: 90,
	critical: 100,
} as const;

export interface LatencyGuardrails {
	thresholdsMs: typeof LATENCY_THRESHOLDS_MS;
	targetRate: number;
	/** How many samples targetRate was computed over — judge it by this, not alone. */
	rateSampleCount: number;
	/** false while rateSampleCount is too low for targetRate to mean anything. */
	rateReliable: boolean;
	over50: number;
	over60: number;
	over80: number;
	over90: number;
	over100: number;
	level: "normal" | "warning" | "incident" | "severe" | "critical";
}

export const IDLE_GUARDRAILS: LatencyGuardrails = {
	thresholdsMs: LATENCY_THRESHOLDS_MS,
	targetRate: 100,
	rateSampleCount: 0,
	rateReliable: false,
	over50: 0,
	over60: 0,
	over80: 0,
	over90: 0,
	over100: 0,
	level: "normal",
};

export interface LatencySnapshot {
	p50: number;
	p95: number;
	p99: number;
	okRate: number;
	count: number;
	windowSize: number;
	last?: LatencySample;
	guardrails: LatencyGuardrails;
}

export interface FastPathSample {
	botId: number;
	ts: number;
	surface: Surface;
	source: "test" | "auto";
	receiveSource?: "push" | "normal-poll" | "dedicated-poll";
	internalMs: number;
	dropped: boolean;
	upstreamCalls: number;
	upstreamMs: number;
}

export interface FastPathSnapshot {
	p50: number;
	p95: number;
	p99: number;
	max: number;
	count: number;
	last?: FastPathSample;
}

export interface FastPathMetrics {
	snapshot: FastPathSnapshot;
	recent: FastPathSample[];
}

export interface HealthStatus {
	senderHealthy: boolean;
	dbHealthy: boolean;
	uptimeSeconds: number;
	botsOnline: number;
	botsTotal: number;
	systemLoad: SystemLoadStatus;
	servers: ServerStatus[];
	lanes: LaneStat[];
}

export interface LaneStat {
	origin: string;
	id: number;
	/** Which local worker process this lane runs on (the `WORKER_ID` label). */
	workerId: string;
	state: "connecting" | "ready" | "draining" | "dead";
	inFlight: number;
	lastOkAt: number;
	/** Raw HTTP/2 PING round trip — connection-level, not real traffic. */
	rttMs?: number;
	/** Measured from real SEND calls only. */
	sendRttMs?: number;
	/** Measured from real poll calls only. */
	pollRttMs?: number;
	lastSendOkAt: number;
	lastPollOkAt: number;
	applicationRttMs?: number;
	applicationSampleAt: number;
	routingPreferred: boolean;
	consecutiveFailures: number;
}

export type MonitoredServerId = "server1" | "server2";

export interface ServerStatus {
	id: MonitoredServerId;
	label: string;
	role: string;
	/** Whether the dashboard backend can reach this machine right now. */
	reachable: boolean;
	/** Health of the service this machine is responsible for. */
	serviceHealthy: boolean;
	load?: Pick<SystemLoadStatus, "cpuPercent" | "memoryPercent" | "capacityPercent" | "exceeded" | "sampledAt">;
	detail?: string;
}

/** One CPU/RAM snapshot recorded on the shared ~30s history clock — see
 * backend/src/monitoring/server-load-history.ts. Powers the Servers tab's
 * trend charts; `/api/health`'s `servers[].load` is the live-now reading. */
export interface ServerLoadSample {
	serverId: MonitoredServerId;
	ts: number;
	cpuPercent: number;
	memoryPercent: number;
	capacityPercent: number;
	eventLoopLagMs: number | null;
}

export interface SystemLoadStatus {
	cpuPercent: number;
	memoryPercent: number;
	eventLoopLagMs: number;
	/** Percentage of the configured limit consumed; 100 means at the limit. */
	capacityPercent: number;
	exceeded: boolean;
	exceededResources: Array<"cpu" | "memory" | "eventLoop">;
	limits: {
		cpuPercent: number;
		memoryPercent: number;
		eventLoopLagMs: number;
	};
	sampledAt: number;
}

export interface BucketCount {
	bucket: string;
	count: number;
}

export interface MetricsSummary {
	totalMessages: number;
	todayCount: number;
	monthCount: number;
	yearCount: number;
	daily: BucketCount[];
	monthly: BucketCount[];
	yearly: BucketCount[];
}

export interface Rule {
	id: number;
	botId: number;
	surface: RuleSurface;
	matchType: "equals" | "startsWith" | "regex" | "containsAny";
	matchValue: string;
	replyText: string;
	enabled: boolean;
	priority: number;
}

/**
 * A post that fires at an exact wall-clock time (Asia/Bangkok) instead of a
 * keyword. `runAt` is epoch ms; `sentAt` is null until the send actually
 * goes out.
 */
export interface ScheduledPost {
	id: number;
	botId: number;
	surface: Surface;
	targetMid: string;
	text: string;
	runAt: number;
	enabled: boolean;
	sentAt: number | null;
}

export interface ChatRow {
	bot_id: number;
	mid: string;
	surface: Surface;
	name: string | null;
	joined_at: number;
	enabled: number;
	admin_only: number;
}

/** One of an owner's bots that also sits in a given OpenChat room — see primary-bot.ts. */
export interface RoomBotInfo {
	botId: number;
	isPrimary: boolean;
	joinedAt: number;
	status: BotStatus;
	name: string | null;
	slot: number | null;
}

/** One live dashboard login — distinct from UserActionLogEntry, which is history. */
export interface ActiveSessionInfo {
	userId: number;
	username: string;
	role: UserRole;
	createdAt: number;
	lastSeenAt: number;
}

/** OpenChat-only — LINE's own ADMIN/CO_ADMIN/MEMBER role for one member. */
export interface SquareMemberInfo {
	mid: string;
	displayName: string;
	role: "ADMIN" | "CO_ADMIN" | "MEMBER" | number;
}

export interface BotEvent {
	id: number;
	bot_id: number | null;
	ts: number;
	type: string;
	message: string | null;
}

export interface UserActionLogEntry {
	id: number;
	user_id: number | null;
	username: string;
	ts: number;
	action: string;
	detail: string | null;
}

export type AnomalySeverity = "info" | "warn" | "critical";

/** One thing that got between a trigger and its reply. */
export interface Anomaly {
	id: number;
	bot_id: number | null;
	ts: number;
	kind: string;
	severity: AnomalySeverity;
	chat_mid: string | null;
	detail: string | null;
}

export interface AnomalySummaryRow {
	kind: string;
	severity: AnomalySeverity;
	count: number;
}

export type LaneRaceResult = "star" | "banana";
export type LaneRaceRole = "send" | "poll";

export interface LaneRaceScore {
	samples: number;
	stars: number;
	bananas: number;
	bigStars: number;
	avgRttMs?: number;
	lastAt?: number;
	lastResult?: LaneRaceResult;
}

export interface LaneRaceLane {
	origin: string;
	laneId: number;
	/** Same purpose as LaneStat.workerId — see there. */
	workerId: string;
	state: string;
	inFlight: number;
	sendRttMs?: number;
	pollRttMs?: number;
	applicationRttMs?: number;
	applicationSampleAt: number;
	routingPreferred: boolean;
	send: LaneRaceScore;
	poll: LaneRaceScore;
}

export interface LaneRaceEvent {
	ts: number;
	origin: string;
	laneId: number;
	role: LaneRaceRole;
	result: LaneRaceResult;
	rttMs: number;
}

export interface LaneRaceDaily {
	day: string;
	stars: number;
	bananas: number;
	send_stars: number;
	send_bananas: number;
	poll_stars: number;
	poll_bananas: number;
}

export interface LaneRaceSnapshot {
	retentionDays: number;
	lanes: LaneRaceLane[];
	daily: LaneRaceDaily[];
	events: LaneRaceEvent[];
	latency: LatencySample[];
}

export interface MessageIn {
	botId: number;
	surface: Surface;
	text: string;
	targetMid: string;
	ts: number;
	/**
	 * LINE's own stamp for when its server accepted this message. Shared by
	 * every participant, so the gap between two messages' stamps times
	 * whoever sent the second one — including a rival bot.
	 */
	createdTime?: number;
}

/**
 * One row of the live feed. Lives here rather than beside the component
 * because the feed now has two sources — the WS stream and the persisted
 * history endpoint — and `lib/` must not import from `components/`.
 */
export type FeedItem = { kind: "in"; id: string; data: MessageIn } | { kind: "out"; id: string; data: LatencySample };

export type WsEventType =
	| "qr"
	| "pincode"
	| "ready"
	| "message_in"
	| "send_result"
	| "send_dropped"
	| "fast_path"
	| "bot_error"
	| "chats_updated"
	| "bot_status"
	| "start_declined"
	| "id_lock_mismatch";

export interface WsEvent<T = unknown> {
	type: WsEventType;
	data: T;
}

/**
 * Payload of the "id_lock_mismatch" event — either a different LINE account
 * tried to log into an already-locked bot ("account", the default), or the
 * same account logged in under a different display name than the one
 * locked at first login ("name").
 */
/**
 * An admin-authored notice shown on every signed-in user's console — the
 * replacement for the old "ผู้บรรยายสนาม" race-commentary card.
 */
export interface Announcement {
	id: number;
	title: string;
	body: string;
	createdByUserId: number | null;
	createdAt: number;
	updatedAt: number;
	isModalAlert: boolean;
	isPinned: boolean;
}

export interface IdLockMismatchEvent {
	botId: number;
	botName: string;
	reason?: "account" | "name";
	/** Only set when reason is "name". */
	previousName?: string;
	/** Only set when reason is "name". */
	attemptedName?: string;
}
