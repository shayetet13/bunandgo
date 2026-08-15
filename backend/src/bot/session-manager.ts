import { EventEmitter } from "node:events";
import { type Client, loginWithAuthToken, loginWithQR, SquareMessage, type TalkMessage } from "../linejs-core/client/mod.ts";
import type { Device } from "../linejs-core/base/mod.ts";
import { createDispatchFetch } from "../dispatch/client.ts";
import { ensureWarm, startWarmer } from "../dispatch/warmer.ts";
import { clearSqliteStorageCache, SqliteStorage } from "../db/sqlite-storage.ts";
import { latencyTracker, sumLatencyBreakdown } from "../metrics/latency.ts";
import { getCompiledRules, matchRule, preloadRules } from "./rules.ts";
import { claimIncomingMessage, claimReply, claimRoomAnswer, clearBotClaims } from "./reply-guard.ts";
import { clearThrottle, tryAcquireSend } from "./rate-limiter.ts";
import { clearChatAccess } from "./chat-access.ts";
import { squareSelfMidKey } from "./square-self-mid-key.ts";
import { clearSquareRoles, resolveSquareMemberRoles } from "./square-roles.ts";
import { logBotEvent } from "./bot-events.ts";
import { sendAlert } from "./alerts.ts";
import { startLogPurgeScheduler } from "./log-purge.ts";
import {
	disableScheduledPost,
	getScheduledPost,
	listAllPendingScheduledPosts,
	listScheduledPosts,
	markScheduledPostSent,
	type ScheduledPost,
} from "./scheduled-posts.ts";
import { sendReply } from "./reply-sender.ts";
import { SessionAttemptGate } from "./session-attempt.ts";
import { shouldDiscardStoredAuthToken } from "./auth-token-policy.ts";
import { planStallRecovery } from "./square-stall-policy.ts";
import { isSquareAccessDenied } from "./square-access-policy.ts";
import { shouldProcessIncomingMessage } from "./incoming-message-policy.ts";
import { clearAutomaticReplyEchoes, isAutomaticReplyEcho, trackAutomaticReply } from "./automatic-reply-echo.ts";
import { claimResend, clearTrackedReplies, MAX_RESENDS, trackSentReply, uniquifyReply, varyText } from "./reply-defense.ts";
import { RESEND_WHEN_INVISIBLE, VERIFY_SENDS_ENABLED } from "./square-visibility.ts";
import { armSquareReplyForensics, clearSquareForensics, observeSquareForensicEvent } from "./square-forensics.ts";
import { clearBotAnomalies, recordAnomaly } from "./anomalies.ts";
import { inboundDelayMs, isSlowInbound, lineCreatedTimeOf, toLineEpochMs } from "./inbound-delay.ts";
import type { SquareEvent, SquareMessageState } from "../linejs-core/types/line_types.ts";
import {
	deleteBot,
	evaluateIdLock,
	getBot,
	isBotOverQuota,
	isOwnerTestingEnabled,
	overQuotaBots,
	resetAllBotStatuses,
	setBotLockedLineMid,
	updateBotStatus,
	type Bot,
} from "./bots.ts";
import { inWorkerScope, WorkerScopeError } from "./worker-scope.ts";
import { db } from "../db/sqlite.ts";
import { enqueueMessageIn } from "../db/write-behind.ts";
import type { Surface } from "../db/schema.ts";
import { fastPathTracker, prewarmFastPathRuntime, runWithFastPath, type FastPathTrace } from "../metrics/fast-path.ts";
import {
	FAST_SQUARE_POLL_ENABLED,
	FAST_SQUARE_POLL_INTERVAL_MS,
	FAST_SQUARE_POLL_MAX_ROOMS,
	FAST_SQUARE_POLL_MAX_ROOMS_REQUESTED,
	FAST_SQUARE_POLL_SLOTS,
	FAST_SQUARE_POLL_WORKERS,
	FAST_SQUARE_POLL_WORKERS_REQUESTED,
	FastSquarePollSlotPool,
	runFastSquarePoller,
} from "./fast-square-poller.ts";
import { selectFastPollRooms, type FastPollCandidate } from "./fast-poll-room.ts";
import { primaryBotIdFor } from "./primary-bot.ts";
import { shouldRunControlPlaneJobs } from "./worker-topology.ts";

export const botEvents = new EventEmitter();
const fastSquarePollSlots = new FastSquarePollSlotPool(FAST_SQUARE_POLL_SLOTS);
let fastSlotRebalanceScheduled = false;

function scheduleFastSlotRebalance(): void {
	if (fastSlotRebalanceScheduled) return;
	fastSlotRebalanceScheduled = true;
	setImmediate(() => {
		fastSlotRebalanceScheduled = false;
		for (const [botId, runtime] of runtimes) {
			if (runtime.client) syncFastSquarePollers(botId);
		}
	});
}

const DISPATCH_URL = process.env.DISPATCH_URL ?? "http://127.0.0.1:4790/dispatch";
const DISPATCH_TOKEN = process.env.DISPATCH_TOKEN;
if (!DISPATCH_TOKEN) {
	throw new Error("DISPATCH_TOKEN env var is required (shared secret with backend/sender)");
}

const upsertChatStmt = db.prepare<null, [number, string, Surface, string | null, number]>(
	"INSERT INTO chats (bot_id, mid, surface, name, joined_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(bot_id, mid) DO UPDATE SET name = excluded.name",
);
const persistedE2eeTargetsStmt = db.prepare<{ key: string }, [number]>(
	"SELECT key FROM kv WHERE bot_id = ? AND key LIKE 'compactE2EETarget:%' AND value_json = 'true' ORDER BY rowid DESC",
);
const hasSquareChatStmt = db.prepare<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM chats WHERE bot_id = ? AND surface = 'square'");
const enabledSquareChatMidsStmt = db.prepare<{ mid: string }, [number]>(
	"SELECT mid FROM chats WHERE bot_id = ? AND surface = 'square' AND enabled = 1 ORDER BY joined_at DESC",
);
/**
 * How much of the recent past counts as "this room is live" when choosing
 * which single OpenChat gets the fast poller. Long enough that a room
 * between triggers is not mistaken for an abandoned one, short enough that
 * yesterday's busy room cannot hold the poller through today.
 */
const FAST_POLL_ACTIVITY_WINDOW_MS = Math.max(60_000, Number(process.env.SQUARE_FAST_POLL_ACTIVITY_WINDOW_MS ?? 15 * 60_000));
const squareRoomActivityStmt = db.prepare<{ target_mid: string; n: number }, [number, number]>(
	"SELECT target_mid, COUNT(*) AS n FROM messages_in WHERE bot_id = ? AND surface = 'square' AND ts >= ? AND target_mid IS NOT NULL GROUP BY target_mid",
);
/** Whether a bot has ever joined an OpenChat — the re-arm chain's staleness is meaningless for a Talk-only bot, which never arms it. */
function botHasSquareChats(botId: number): boolean {
	return (hasSquareChatStmt.get(botId)?.n ?? 0) > 0;
}
const COMPACT_E2EE_TARGET_KEY_PREFIX = "compactE2EETarget:";
const WARMUP_MIN_ITERATIONS = Math.max(8, Number(process.env.HOT_WARMUP_MIN ?? 20));
const WARMUP_MAX_ITERATIONS = Math.max(WARMUP_MIN_ITERATIONS, Number(process.env.HOT_WARMUP_MAX ?? 64));
const WARMUP_TARGET_MS = Math.max(0.05, Number(process.env.HOT_WARMUP_TARGET_MS ?? 0.5));
const WARMUP_TEXT_LIMIT = Math.max(1, Number(process.env.HOT_WARMUP_TEXT_LIMIT ?? 32));

// No session survives the process, so any status left in the table is a
// leftover from a previous run and would misreport a dead bot as alive.
// The ids are the bots that were running when the process died — kept so
// `resumePreviouslyRunningBots` can bring exactly those back.
const previouslyRunningBotIds = resetAllBotStatuses();

// Started at import rather than when a bot goes online: the connections
// this keeps alive are shared by every bot, and a bot started later would
// otherwise pay a cold handshake on its very first reply.
if (process.env.NODE_ENV !== "test") {
	startWarmer({ url: DISPATCH_URL, token: DISPATCH_TOKEN });
	// The workers share one SQLite file. Let only the public control-plane
	// process own destructive global maintenance; a shard must never race a
	// second purge against rows being written between two transactions.
	if (shouldRunControlPlaneJobs()) startLogPurgeScheduler();
	// Not called here: startScheduledPostRunner() needs scheduledPostTimers,
	// a const declared much further down this file. Module-level `const`
	// bindings are not initialized until their own declaration line runs, so
	// calling it this early throws "Cannot access before initialization" —
	// it is invoked instead right after that declaration, further down.
}

// A LINE QR login that nobody scans in time expires server-side; retrying
// with a brand-new QR (rather than just failing) is what makes the
// "auto refresh QR on expiry" behavior work — see attemptLogin's catch.
const RETRY_DELAY_MS = 2000;

const AUTH_TOKEN_KEY = "authToken";

/**
 * How often the bot proves its session is still authenticated.
 *
 * The push connection can stop delivering without closing — LINE stops
 * pushing, nothing throws, and the bot looks online while answering
 * nothing. A quiet chat is indistinguishable from a dead session by
 * traffic alone, so liveness is asserted with an explicit call instead of
 * inferred from silence.
 */
const WATCHDOG_INTERVAL_MS = 60_000;

/**
 * One failed probe is usually a transient network blip; recovery tears
 * down a working session, so it takes two consecutive failures.
 */
const WATCHDOG_FAILURES_BEFORE_RECOVERY = 2;

/**
 * How often to check whether OpenChat's re-arm chain has gone silent.
 *
 * Cheap (a timestamp comparison, no network call), so this runs far more
 * often than the noop watchdog above — the failure it looks for is a stall
 * that can otherwise run for minutes with the bot still reporting "online"
 * (see `SQUARE_STALL_MS`), and checking every 60s would mean living with
 * most of that stall before even noticing it.
 */
const SQUARE_STALL_CHECK_INTERVAL_MS = 5_000;

// How long OpenChat can go silent before it counts as stalled, how long a
// genuine recovery gets left alone, and how many failed recoveries earn a full
// rebuild — all in square-stall-policy.ts, with the production timeline that
// motivated each one written up there.

/**
 * How often to proactively refresh the push connection, ahead of the
 * silent stall this account has been observed hitting roughly every 20-21
 * minutes (occasionally ~29) — see the reactive watchdog below for how
 * that was found. Comfortably under the shortest gap actually measured
 * (~19.7 min), so in the common case this replaces "wait for it to go
 * silent, then notice within 8-13s" with "it never goes silent at all" —
 * same lightweight, no-disruption refresh, just on our own schedule
 * instead of reacting to LINE's.
 *
 * Experimental: the true trigger on LINE's side is unconfirmed (no public
 * documentation for this protocol), so this is a best-effort preemption,
 * not a guarantee — the reactive watchdog stays in place as the backstop
 * for whatever this doesn't catch.
 */
const SQUARE_PROACTIVE_REFRESH_MS = 15 * 60 * 1000;
/** How often the proactive-refresh check runs — cheap (a timestamp compare), so this can be coarse. */
const SQUARE_PROACTIVE_CHECK_INTERVAL_MS = 60_000;

/**
 * What a login attempt is currently waiting on, while the bot is "connecting".
 *
 * - `resuming` — trying the stored session; no QR exists yet
 * - `awaiting_scan` — a QR/PIN is on offer, the one phase a human can act on
 * - `preparing` — LINE accepted the credential; the session is being built
 *
 * LINE consumes the QR (and the PIN) the moment it accepts them, but the
 * attempt then spends several more seconds in `preparing` — chat list, self
 * mids, hot-path warmup — with the status still "connecting" throughout.
 * Without this distinction the dashboard keeps rendering the QR it was handed
 * for that entire window, so someone who has already scanned successfully is
 * still looking at a login screen, and scanning again only feeds LINE a code
 * it has already spent.
 */
export type LoginPhase = "resuming" | "awaiting_scan" | "preparing";

interface BotRuntime {
	client?: Client;
	/** Stable for the lifetime of a bot; cached so reply admission never queries SQLite for ownership. */
	ownerUserId?: number | null;
	listenAbort?: AbortController;
	stopRequested: boolean;
	loginRun?: Promise<void>;
	loginGate: SessionAttemptGate;
	retryTimer?: ReturnType<typeof setTimeout>;
	watchdogTimer?: ReturnType<typeof setInterval>;
	watchdogFailures: number;
	/** See startSquareStallWatch — separate from watchdogTimer because it checks a timestamp, not an API call, so it can run far more often without cost. */
	squareStallTimer?: ReturnType<typeof setInterval>;
	/** See startSquareProactiveRefresh. */
	squareRefreshTimer?: ReturnType<typeof setInterval>;
	/** Wall-clock time the push connection was last force-refreshed, by either the reactive stall watch or the proactive one — shared so neither fires needlessly right after the other already did. */
	lastPushRefreshAt?: number;
	/**
	 * Consecutive stall refreshes that did not bring the square chain back.
	 * Reset the moment a fetch response lands, so this only ever counts a
	 * single unbroken stall — see square-stall-policy.ts for why repeating the
	 * same refresh forever was the bug.
	 */
	squareStallRefreshes?: number;
	/** Whether the cheap in-place re-arm has been spent on the current stall. Cleared the moment the chain answers again. */
	squareStallRearmTried?: boolean;
	/** Aggressive per-room Square listeners racing the ordinary push path. */
	fastSquarePollers?: Map<string, AbortController>;
	/** Interval used by the currently armed pollers; changes restart them. */
	fastSquarePollIntervalMs?: number;
	/** Rooms LINE has explicitly denied during this manually-started session. */
	fastSquarePollBlocked?: Set<string>;
	/**
	 * Whether an outage alert has gone out for the current down period, so
	 * coming back online sends exactly one "recovered" and an ordinary start
	 * sends none.
	 */
	alertedDown?: boolean;
	/**
	 * The QR/pincode currently waiting to be scanned, if any.
	 *
	 * `qr`/`pincode` WS events are fire-and-forget — a dashboard tab whose
	 * socket happens to reconnect in the gap between a failed login attempt
	 * and its retry (both routine: LINE's own servers occasionally answer
	 * the QR handshake with a mid-request GOAWAY) never sees the fresh QR
	 * the retry generates, and is left showing a stale "waiting for QR"
	 * placeholder with nothing left to scan. Keeping the latest one here
	 * lets a reconnecting client ask for it directly instead of only ever
	 * being pushed it once.
	 *
	 * Cleared as soon as the code is spent — see `enterPhase`.
	 */
	currentQr?: { url?: string; pincode?: string };
	/** Only meaningful while the bot is "connecting". */
	loginPhase?: LoginPhase;
}

// Each entry is a fully independent, logged-in LINE session — separate
// BaseClient, separate SqliteStorage (bot-scoped), no shared state between
// bot accounts other than the (stateless, protocol-agnostic) Go dispatcher.
const runtimes = new Map<number, BotRuntime>();

/**
 * Counts of the live, in-RAM state this module owns, for /api/health.
 *
 * Diagnostic only. Each of these is supposed to shrink back down once a bot
 * stops or a poller's room changes — a count that only ever grows across
 * many reconnects, independent of how much real traffic happened, is what a
 * timer or AbortController that never got cleared up looks like from
 * outside the process.
 */
export function getRuntimeDiagnostics(): {
	runtimes: number;
	withClient: number;
	watchdogTimers: number;
	squareStallTimers: number;
	squareRefreshTimers: number;
	fastSquarePollers: number;
	retryTimersPending: number;
} {
	let withClient = 0;
	let watchdogTimers = 0;
	let squareStallTimers = 0;
	let squareRefreshTimers = 0;
	let fastSquarePollers = 0;
	let retryTimersPending = 0;
	for (const rt of runtimes.values()) {
		if (rt.client) withClient++;
		if (rt.watchdogTimer) watchdogTimers++;
		if (rt.squareStallTimer) squareStallTimers++;
		if (rt.squareRefreshTimer) squareRefreshTimers++;
		if (rt.retryTimer) retryTimersPending++;
		fastSquarePollers += rt.fastSquarePollers?.size ?? 0;
	}
	return {
		runtimes: runtimes.size,
		withClient,
		watchdogTimers,
		squareStallTimers,
		squareRefreshTimers,
		fastSquarePollers,
		retryTimersPending,
	};
}

/**
 * The QR/pincode currently waiting to be scanned for a bot, plus which phase
 * of the login the bot is in.
 *
 * A REST fallback for the `qr`/`pincode` WS events: those only ever fire
 * once, so a dashboard tab whose socket reconnects in the gap between a
 * failed handshake and its retry never receives the fresh one and is stuck
 * showing a placeholder with nothing left to scan. The phase travels with it
 * because "no QR" is ambiguous on its own — it means "not your turn yet"
 * during a resume and "already scanned, nearly there" afterwards, and a
 * reconnecting tab has no other way to tell those apart.
 *
 * Every exit path clears both (see `clearLoginPending`), so this cannot hand
 * back a code from a finished attempt; the route layer additionally gates on
 * the bot being "connecting".
 */
export function getCurrentQr(botId: number): { url?: string; pincode?: string; phase?: LoginPhase } | undefined {
	const rt = runtimes.get(botId);
	if (!rt) return undefined;
	return { ...rt.currentQr, phase: rt.loginPhase };
}

/**
 * Publishes which half of "connecting" the bot is in.
 *
 * Any phase but "awaiting_scan" also drops the QR/pincode, because in every
 * one of them the code we hold is either spent (LINE accepted it) or
 * superseded (a new attempt started). Anything still holding it — a dashboard
 * tab, or `GET /api/bots/:botId/qr` — would otherwise go on offering a dead
 * code to scan for the rest of the attempt.
 */
function enterPhase(botId: number, rt: BotRuntime, phase: LoginPhase): void {
	if (phase !== "awaiting_scan") rt.currentQr = undefined;
	if (rt.loginPhase === phase) return;
	rt.loginPhase = phase;
	botEvents.emit("bot_status", { botId, status: "connecting", phase });
}

/** Nothing is pending once an attempt ends, whichever way it ended. */
function clearLoginPending(rt: BotRuntime): void {
	rt.currentQr = undefined;
	rt.loginPhase = undefined;
}

function getRuntime(botId: number): BotRuntime {
	let rt = runtimes.get(botId);
	if (!rt) {
		rt = { stopRequested: false, loginGate: new SessionAttemptGate(), watchdogFailures: 0 };
		runtimes.set(botId, rt);
	}
	return rt;
}

function buildInit(botId: number, device: Device) {
	return {
		device,
		storage: new SqliteStorage(botId),
		fetch: createDispatchFetch({ url: DISPATCH_URL, token: DISPATCH_TOKEN as string }),
	};
}

export async function startBot(botId: number): Promise<void> {
	const bot = getBot(botId);
	if (!bot) throw new Error("ไม่พบบอทนี้");
	// Hard rail against a bot logging in on two processes at once: even a
	// stale dashboard tab or a misrouted API call against the wrong worker
	// cannot start a bot this process was not assigned (see worker-scope.ts).
	if (!inWorkerScope(bot.ownerUserId)) throw new WorkerScopeError("บอทนี้ไม่ได้อยู่ในความรับผิดชอบของ worker นี้");
	const rt = getRuntime(botId);
	if (rt.client || rt.loginRun) throw new Error("บอทนี้ออนไลน์อยู่แล้วหรือกำลังเข้าสู่ระบบ");
	rt.ownerUserId = bot.ownerUserId;

	rt.stopRequested = false;
	// An explicit start is the operator's signal that account access or room
	// membership may have changed. A background retry must not keep hammering
	// a room LINE already denied, but a newly authorized room may be tried now.
	rt.fastSquarePollBlocked?.clear();
	if (rt.retryTimer) {
		clearTimeout(rt.retryTimer);
		rt.retryTimer = undefined;
	}
	// Warm the reply path before the session exists, so the first matching
	// message does not pay for a cache miss on top of everything else.
	preloadRules(botId);
	await beginLogin(botId, bot.device as Device);
}

/** Spacing between unattended resumes, so N bots don't all hit LINE at once. */
const RESUME_STAGGER_MS = 3000;

/**
 * Brings back the bots that were running when the previous process ended.
 *
 * Without this a restart leaves every bot offline until a human notices and
 * presses "เริ่ม" — the gap that turned a 3-second systemd restart into
 * hours of silence.
 *
 * Resume is token-only and deliberately one-shot per bot: it reuses the
 * session LINE already issued rather than performing a new login, which is
 * both what makes it unattended and what keeps it clear of the
 * login-frequency behaviour that gets accounts flagged. A bot whose token
 * LINE has invalidated is left offline with an error on the dashboard,
 * because only a human with the phone can fix that.
 */
export async function resumePreviouslyRunningBots(): Promise<void> {
	for (const botId of previouslyRunningBotIds) {
		const bot = getBot(botId);
		if (!bot) continue;
		// No stored credential means the only way back is a QR nobody is
		// waiting to scan. Skip rather than start a session that cannot finish.
		const storage = new SqliteStorage(botId);
		const authToken = await storage.get(AUTH_TOKEN_KEY).catch(() => undefined);
		if (typeof authToken !== "string" || !authToken) {
			console.log(`[bot ${botId}] resume skipped: no stored session`);
			logBotEvent(botId, "resume_skipped", "ไม่มีเซสชันที่บันทึกไว้ ต้องกดเริ่มแล้วสแกน QR ใหม่");
			continue;
		}
		getRuntime(botId).ownerUserId = bot.ownerUserId;

		const rt = getRuntime(botId);
		if (rt.client) continue;
		rt.stopRequested = false;
		// Everything for this bot — including preloadRules, which used to sit
		// outside this block — is wrapped in one try/catch: a throw here used
		// to propagate out of the whole `for` loop, silently skipping
		// beginLogin for every bot listed *after* the failing one. A restart
		// that should have brought back three bots could bring back only the
		// first, offline forever with nothing pointing at why.
		try {
			preloadRules(botId);
			console.log(`[bot ${botId}] resuming session after restart`);
			logBotEvent(botId, "resume_attempt", "กำลังกู้คืนเซสชันเดิมหลัง backend รีสตาร์ท");
			await beginLogin(botId, bot.device as Device, { qrFallback: false });
		} catch (err) {
			emitError(botId, err);
			recordAnomaly({
				botId,
				kind: "resume_failed",
				severity: "critical",
				detail: `กู้คืนเซสชันหลัง backend รีสตาร์ทไม่สำเร็จ — ${err instanceof Error ? err.message : String(err)}`,
			});
		}
		await new Promise((resolve) => setTimeout(resolve, RESUME_STAGGER_MS));
	}
}

interface AttemptLoginOptions {
	/**
	 * Whether a missing/rejected stored token may fall through to a QR login.
	 * False for unattended restarts — see the note in `attemptLogin`.
	 */
	qrFallback?: boolean;
	generation: number;
}

function isCurrentAttempt(rt: BotRuntime, generation: number): boolean {
	return rt.loginGate.isCurrent(generation) && !rt.stopRequested;
}

function beginLogin(botId: number, device: Device, options: Omit<AttemptLoginOptions, "generation"> = {}): Promise<void> {
	// Every way a session can begin funnels through here — the dashboard's
	// start, the confirmation that follows it, the reconnect retry, and the
	// unattended resume after a restart. Guarding only the first would let a
	// bot the customer stopped paying for come straight back on the next
	// deploy, which is the same as not guarding it at all.
	if (isBotOverQuota(botId)) {
		throw new Error("บอทนี้เกินโควตาของเจ้าของบัญชี — ติดต่อผู้ดูแลระบบเพื่อเพิ่มโควตาก่อนจึงจะเปิดได้");
	}
	const rt = getRuntime(botId);
	const generation = rt.loginGate.begin();
	if (generation === undefined) throw new Error("มีการเข้าสู่ระบบของบอทนี้อยู่แล้ว");
	const run = attemptLogin(botId, device, { ...options, generation });
	rt.loginRun = run;
	void run
		.finally(() => {
			rt.loginGate.finish(generation);
			if (rt.loginRun === run) rt.loginRun = undefined;
		})
		.catch(() => {
			// attemptLogin owns error reporting; this catch only prevents the
			// cleanup promise from becoming an unhandled rejection.
		});
	return run;
}

/**
 * Brings a bot online, preferring the stored access token over a QR scan.
 *
 * A QR scan is a human action; requiring one after every restart is what
 * turns a transient outage into an unattended bot sitting offline. The
 * token path is attempted first and silently falls through to QR when
 * there is no token or LINE rejects the one on file.
 */
async function attemptLogin(botId: number, device: Device, options: AttemptLoginOptions): Promise<void> {
	// An unattended restart has nobody watching to scan: falling back to QR
	// there would spin the retry loop below forever, minting a fresh QR every
	// couple of seconds for a bot nobody is looking at. Resume-only stops at
	// the first failure and reports it instead.
	const { qrFallback = true } = options;
	const rt = getRuntime(botId);
	const { generation } = options;
	if (!isCurrentAttempt(rt, generation)) return;
	// Every attempt opens by trying the stored session; it only becomes the
	// user's turn if that fails and LINE hands us a fresh code.
	rt.currentQr = undefined;
	rt.loginPhase = "resuming";
	updateBotStatus(botId, "connecting");
	botEvents.emit("bot_status", { botId, status: "connecting", phase: "resuming" });

	try {
		const resumed = await resumeWithStoredToken(botId, device);
		if (!isCurrentAttempt(rt, generation)) return;
		if (!resumed && !qrFallback) {
			clearLoginPending(rt);
			updateBotStatus(botId, "offline");
			botEvents.emit("bot_status", { botId, status: "offline" });
			emitError(botId, new Error('เซสชันเดิมหมดอายุ (LINE ตัดออกจากระบบ) — ต้องกด "เริ่ม" แล้วสแกน QR ใหม่'));
			// The one state nothing here can recover from: it needs a human
			// with the phone, so it must reach one rather than sit on a
			// dashboard nobody has open.
			sendAlert("login_required", botId, getBot(botId)?.name ?? String(botId));
			return;
		}
		const client =
			resumed ??
			(await loginWithQR(
				{
					onReceiveQRUrl(url) {
						if (!isCurrentAttempt(rt, generation)) return;
						rt.currentQr = { ...rt.currentQr, url };
						botEvents.emit("qr", { botId, url });
						enterPhase(botId, rt, "awaiting_scan");
					},
					onPincodeRequest(pin) {
						if (!isCurrentAttempt(rt, generation)) return;
						rt.currentQr = { ...rt.currentQr, pincode: pin };
						botEvents.emit("pincode", { botId, pin });
						enterPhase(botId, rt, "awaiting_scan");
					},
				},
				buildInit(botId, device),
			));

		if (!isCurrentAttempt(rt, generation)) return;

		// Past this point LINE has accepted the credential and the code on
		// screen is spent — everything below is preparation the user cannot
		// help with, so stop showing them something to scan.
		enterPhase(botId, rt, "preparing");

		rt.client = client;
		rt.watchdogFailures = 0;

		// One LINE account per bot slot: the first account to log in locks
		// it, and a different account scanning this bot's QR afterward is
		// rejected before its token is ever persisted (trackAuthToken below)
		// or the session goes online. evaluateIdLock is the pure decision
		// (see bot/bots.ts); everything here is the I/O it requires.
		const lineMid = client.base.profile?.mid;
		if (lineMid) {
			const loginBot = getBot(botId);
			const idLockOutcome = loginBot ? evaluateIdLock(loginBot, lineMid) : "exempt";
			if (idLockOutcome === "first_login") {
				setBotLockedLineMid(botId, lineMid);
			} else if (idLockOutcome === "mismatch") {
				rt.client = undefined;
				rt.listenAbort?.abort();
				rt.listenAbort = undefined;
				clearLoginPending(rt);
				updateBotStatus(botId, "offline");
				botEvents.emit("bot_status", { botId, status: "offline" });
				botEvents.emit("id_lock_mismatch", { botId, botName: loginBot?.name ?? String(botId) });
				recordAnomaly({
					botId,
					kind: "id_lock_mismatch",
					severity: "critical",
					detail: "มีความพยายามเข้าสู่ระบบด้วยบัญชี LINE อื่น — บอทนี้ผูกไว้กับบัญชีแรกที่เคยเข้าสู่ระบบสำเร็จแล้ว",
				});
				logBotEvent(botId, "id_lock_rejected", "ปฏิเสธการเข้าสู่ระบบ — บัญชี LINE ไม่ตรงกับที่ผูกไว้กับบอทนี้");
				return;
			}
		}

		trackAuthToken(botId, client);
		// Pull the persisted reqseq counters into memory now; otherwise the
		// first send would be the one that waits on that read.
		await Promise.all([client.base.preloadReqseq(), ensureWarm({ url: DISPATCH_URL, token: DISPATCH_TOKEN })]);
		if (!isCurrentAttempt(rt, generation)) return;
		// Resolve chat/self identity while still connecting. Once `online` is
		// visible, receiving and answering must be a fully warm operation.
		const chatMids = await refreshChatsCache(botId, client);
		if (!isCurrentAttempt(rt, generation)) return;
		await prewarmFastPathRuntime(botId);
		// Keep this bounded and sequential. A broad Promise.all filled the
		// young heap immediately before online and made the first reply a
		// likely place for its collection.
		for (const mid of chatMids.talk) {
			await client.base.talk.prewarmCompactSendTarget(mid);
			if (!isCurrentAttempt(rt, generation)) return;
		}
		await client.base.square.prewarmSendMessage(chatMids.square[0] ?? `m${"0".repeat(32)}`);
		if (!isCurrentAttempt(rt, generation)) return;
		// The first encrypted reply otherwise pays cold key lookup/crypto JIT
		// (measured at ~13ms on Windows). Build and discard encrypted chunks
		// for known targets now, before listeners and the online state exist.
		const warmE2eeTargets: string[] = [];
		for (const { key } of persistedE2eeTargetsStmt.all(botId)) {
			const target = key.slice(COMPACT_E2EE_TARGET_KEY_PREFIX.length);
			if (await client.base.talk.prewarmCompactE2EETarget(target)) {
				warmE2eeTargets.push(target);
			}
			if (!isCurrentAttempt(rt, generation)) return;
		}

		// The readiness gate exercises the exact automatic-reply shapes against
		// RAM ACKs, forces startup garbage out, then verifies the post-GC path.
		// It cannot send a message to LINE.
		await prewarmAutomaticReplyPath(botId, client, chatMids, warmE2eeTargets);
		if (!isCurrentAttempt(rt, generation)) return;

		// Attach consumers before publishing online; there must be no visible
		// window where the dashboard says ready but no message listener exists.
		wireListeners(botId, client, rt);
		clearLoginPending(rt);
		updateBotStatus(botId, "online");
		botEvents.emit("bot_status", { botId, status: "online" });
		botEvents.emit("ready", { botId, profile: client.base.profile });
		logBotEvent(botId, "online", "เชื่อมต่อสำเร็จ บอทออนไลน์แล้ว");
		// Only newsworthy if we actually told someone it was down — otherwise
		// every ordinary start would announce a recovery from nothing.
		if (rt.alertedDown) {
			rt.alertedDown = false;
			sendAlert("recovered", botId, getBot(botId)?.name ?? String(botId));
		}
		startWatchdog(botId, device, rt);
	} catch (err) {
		if (!isCurrentAttempt(rt, generation)) return;
		// The session can be half-built here: `rt.client` is assigned before
		// the preparation steps that may throw. Leaving it behind marks the
		// bot as already running, so the "เริ่ม" button answers "บอทนี้
		// ออนไลน์อยู่แล้ว" for a bot the dashboard is showing as offline.
		rt.listenAbort?.abort();
		rt.listenAbort = undefined;
		rt.client = undefined;
		clearLoginPending(rt);
		updateBotStatus(botId, "offline");
		botEvents.emit("bot_status", { botId, status: "offline" });
		if (rt.stopRequested) return;

		emitError(botId, err);
		// An unplanned drop — `stopRequested` above already excluded the
		// operator pressing "หยุด". Dedupe inside `sendAlert` keeps a bot
		// that is flapping (or sitting in the QR retry loop below) from
		// sending one of these every couple of seconds.
		rt.alertedDown = true;
		sendAlert("offline", botId, getBot(botId)?.name ?? String(botId), err instanceof Error ? err.message : undefined);
		// Resume-only callers have no watcher; retrying would loop on a
		// credential that is already known bad.
		if (!qrFallback) return;
		// The QR expired (or the handshake otherwise failed) without a
		// stop request — automatically generate a fresh QR rather than
		// leaving the bot stuck offline with nothing to scan.
		rt.retryTimer = setTimeout(() => {
			rt.retryTimer = undefined;
			if (isCurrentAttempt(rt, generation) && !rt.client) {
				void beginLogin(botId, device).catch((retryErr) => emitError(botId, retryErr));
			}
		}, RETRY_DELAY_MS);
	}
}

function clampWarmText(text: string): string {
	// Match the same practical upper bound as inbound matching. This also
	// prevents an accidentally huge configured reply from turning startup
	// preparation into an unbounded allocation burst.
	return text.length > 4096 ? text.slice(0, 4096) : text;
}

function findRuleProbeText(botId: number): string | undefined {
	const rules = getCompiledRules(botId);
	for (const rule of rules) {
		if (!rule.enabled) continue;
		const candidates: string[] = [];
		switch (rule.matchType) {
			case "equals":
				candidates.push(rule.matchValue);
				break;
			case "startsWith":
				candidates.push(`${rule.matchValue} warm`);
				break;
			case "containsAny":
				candidates.push(
					rule.matchValue
						.split(",")
						.map((part) => part.trim())
						.find(Boolean) ?? "",
				);
				break;
			case "regex":
				// Common anchored/alternative regexes yield useful literal tokens.
				candidates.push(rule.matchValue, ...(rule.matchValue.match(/[!\p{L}\p{N}_-]+/gu) ?? []), "!ping", "test", "ทดสอบ");
				break;
		}
		for (const candidate of candidates) {
			if (rule.test(candidate)) return candidate;
		}
	}
	return undefined;
}

function makeWarmTrace(botId: number, surface: Surface): FastPathTrace {
	return {
		botId,
		surface,
		source: "auto",
		receivedAt: performance.now(),
		decryptMs: 0,
		matchMs: 0,
		admissionMs: 0,
		protocolPrepMs: 0,
		relayEncodeMs: 0,
		goPrepMs: 0,
		upstreamCalls: 0,
		upstreamMs: 0,
	};
}

/**
 * Moves JSC tiering, UTF-8 branches, first allocations and startup GC in
 * front of the ready boundary. Every fetch in this function is intercepted
 * by BaseClient and answered from RAM; no request can reach LINE.
 */
async function prewarmAutomaticReplyPath(
	botId: number,
	client: Client,
	chatMids: { talk: string[]; square: string[] },
	e2eeTargets: string[],
): Promise<void> {
	const rules = getCompiledRules(botId);
	const replyTexts = [
		...new Set(["warm", "ทดสอบ 🚀", ...rules.filter((rule) => rule.enabled).map((rule) => clampWarmText(rule.replyText))]),
	].slice(0, WARMUP_TEXT_LIMIT);
	const dryTalkTargets = [`u${"0".repeat(32)}`, `r${"0".repeat(32)}`, `c${"0".repeat(32)}`];
	const dryTalkMid = chatMids.talk.find((mid) => /^[rc][0-9a-f]{32}$/i.test(mid)) ?? dryTalkTargets[2]!;
	const drySquareMid = chatMids.square[0] ?? `m${"0".repeat(32)}`;

	// Unconditionally compile native X25519, AES-GCM, Thai/emoji JSON and
	// decrypt. This covers a brand-new installation with no persisted E2EE
	// target yet.
	for (let i = 0; i < 3; i++) client.base.e2ee.prewarmCrypto();

	// Warm every configured reply text and every compact MID prefix. Square
	// includes the threaded-reply fields used by real automatic replies.
	await client.base.prewarmHotRequests(async () => {
		for (let pass = 0; pass < 3; pass++) {
			for (const text of replyTexts) {
				for (const to of dryTalkTargets) {
					await client.base.talk.sendCompactMessage({ to, text, fastAck: true });
				}
				await client.base.square.sendMessage({
					squareChatMid: drySquareMid,
					text,
					relatedMessageId: `warm-${pass}`,
					fastAck: true,
				});
			}
		}
		for (const to of e2eeTargets) {
			await client.base.talk.sendCompactMessage({
				to,
				text: replyTexts[0]!,
				e2ee: true,
				fastAck: true,
			});
		}
	});

	const probeText = findRuleProbeText(botId);
	const shadowBotId = -1_000_000_000 - botId;
	let sequence = 0;
	const drySquareSelfKey = squareSelfMidKey(botId, drySquareMid);
	const seededSquareSelf = !squareSelfMids.has(drySquareSelfKey);
	if (seededSquareSelf) squareSelfMids.set(drySquareSelfKey, `m${"f".repeat(32)}`);

	const runOne = async (surface: Surface): Promise<number> => {
		clearThrottle(shadowBotId);
		clearBotClaims(shadowBotId);
		const startedAt = performance.now();
		await client.base.prewarmHotRequests(async () => {
			if (probeText !== undefined) {
				sequence++;
				const message =
					surface === "talk"
						? ({
								text: probeText,
								to: { id: dryTalkMid, type: "GROUP" },
								from: { id: `u${"e".repeat(32)}` },
								isMyMessage: false,
								raw: { id: `warm-talk-${sequence}` },
							} as unknown as TalkMessage)
						: ({
								text: probeText,
								to: { id: drySquareMid, type: "SQUARE" },
								from: { id: `m${"e".repeat(32)}` },
								raw: {
									message: {
										id: `warm-square-${sequence}`,
										to: drySquareMid,
									},
								},
							} as unknown as SquareMessage);
				await handleIncoming(botId, surface, message, {
					prewarmGuardBotId: shadowBotId,
				});
				return;
			}

			// A bot with no currently matchable rule still warms sendTimed,
			// limiter and ALS so adding its first rule later has no runtime cold
			// branch. Matcher functions were exercised by findRuleProbeText.
			const trace = makeWarmTrace(botId, surface);
			await sendTimed(
				botId,
				surface,
				surface === "talk" ? dryTalkMid : drySquareMid,
				replyTexts[0]!,
				"auto",
				() =>
					surface === "talk"
						? client.base.talk.sendCompactMessage({
								to: dryTalkMid,
								text: replyTexts[0]!,
								fastAck: true,
							})
						: client.base.square.sendMessage({
								squareChatMid: drySquareMid,
								text: replyTexts[0]!,
								relatedMessageId: "warm",
								fastAck: true,
							}),
				trace,
				shadowBotId,
			);
		});
		return performance.now() - startedAt;
	};

	try {
		// First tiering phase.
		for (let i = 0; i < WARMUP_MIN_ITERATIONS; i++) {
			await runOne("talk");
			await runOne("square");
		}

		// Move startup garbage out, then verify the path after collection.
		Bun.gc(true);
		await new Promise<void>((resolve) => setImmediate(resolve));

		let verified = 0;
		let stableBatches = 0;
		let observedMax = 0;
		while (verified < WARMUP_MAX_ITERATIONS && stableBatches < 3) {
			let batchMax = 0;
			for (let i = 0; i < 4 && verified < WARMUP_MAX_ITERATIONS; i++) {
				batchMax = Math.max(batchMax, await runOne("talk"));
				batchMax = Math.max(batchMax, await runOne("square"));
				verified++;
			}
			observedMax = Math.max(observedMax, batchMax);
			stableBatches = batchMax <= WARMUP_TARGET_MS ? stableBatches + 1 : 0;
		}
		console.log(
			`[bot ${botId}] hot path ready: ${verified} post-GC cycles, ` + `max=${observedMax.toFixed(3)}ms, stable=${stableBatches}/3`,
		);
	} finally {
		clearThrottle(shadowBotId);
		clearBotClaims(shadowBotId);
		if (seededSquareSelf) squareSelfMids.delete(drySquareSelfKey);
	}
}

/**
 * Restores a session from the access token on file, or returns undefined
 * when there is none to use — a refused token is an expected outcome, not
 * an error worth surfacing, since the caller falls back to a QR scan.
 *
 * The stored refresh token is deliberately not used on its own: LINE's
 * refresh RPC answers 403 unless an access token accompanies it, so the
 * refresh token is only useful *through* this path, where `loginWithAuthToken`
 * puts it in storage and the request layer spends it automatically the
 * first time the access token comes back stale.
 */
async function resumeWithStoredToken(botId: number, device: Device): Promise<Client | undefined> {
	const storage = new SqliteStorage(botId);
	const authToken = await storage.get(AUTH_TOKEN_KEY).catch(() => undefined);
	if (typeof authToken !== "string" || !authToken) return undefined;

	try {
		const client = await loginWithAuthToken(authToken, buildInit(botId, device));
		botEvents.emit("resumed", { botId });
		return client;
	} catch (error) {
		// A network/relay failure says nothing about the credential. Preserve
		// it and let attemptLogin retry; otherwise one transient outage turns
		// an unattended restart into a QR login. Only LINE's explicit auth
		// rejection is allowed to erase the token and fall through to QR.
		if (!shouldDiscardStoredAuthToken(error)) throw error;
		await storage.delete(AUTH_TOKEN_KEY).catch(() => {});
		return undefined;
	}
}

/**
 * Persists the current token and every rotation LINE sends afterwards.
 *
 * LINE hands back a replacement token in `x-line-next-access` as sessions
 * age. Without capturing it the client keeps presenting a token that will
 * eventually be refused, and the bot drops offline mid-operation with no
 * way back except a QR scan.
 */
function trackAuthToken(botId: number, client: Client): void {
	const storage = new SqliteStorage(botId);
	const persist = (token: string): void => {
		void storage.set(AUTH_TOKEN_KEY, token).catch(() => {});
	};
	let pendingToken: string | undefined;
	let persistQueued = false;
	const persistAfterReply = (token: string): void => {
		pendingToken = token;
		if (persistQueued) return;
		persistQueued = true;
		setImmediate(() => {
			persistQueued = false;
			const latest = pendingToken;
			pendingToken = undefined;
			if (latest) persist(latest);
		});
	};

	if (client.base.authToken) persist(client.base.authToken);
	client.base.on("update:authtoken", (token: string) => {
		// Authentication state changes synchronously; durable storage is
		// coalesced after the ACK so a rare token rotation cannot delay it.
		client.base.authToken = token;
		persistAfterReply(token);
	});
}

export function stopBot(botId: number): void {
	// Same rail as startBot(): without this, a bot actually running on
	// another process (out of this one's worker scope) would still get its
	// shared DB status flipped to "offline" below — the exact status-lie
	// resetAllBotStatuses() exists to prevent, reachable here through the
	// ordinary stop/delete API instead of a boot-time reset. deleteBotSession
	// calls stopBot() first, so this also covers bot deletion.
	const bot = getBot(botId);
	if (!bot) return;
	if (!inWorkerScope(bot.ownerUserId)) {
		throw new WorkerScopeError("บอทนี้ไม่ได้อยู่ในความรับผิดชอบของ worker นี้");
	}

	const rt = runtimes.get(botId);
	const wasRunning = rt?.client !== undefined || bot.status !== "offline";
	if (rt) {
		rt.stopRequested = true;
		if (rt.retryTimer) {
			clearTimeout(rt.retryTimer);
			rt.retryTimer = undefined;
		}
		stopWatchdog(rt);
		if (rt.listenAbort) {
			rt.listenAbort.abort();
			rt.listenAbort = undefined;
		}
		rt.client = undefined;
		rt.loginGate.invalidate();
		rt.loginRun = undefined;
		clearLoginPending(rt);
	}
	// A restarted session re-reads history from its own sync token, so
	// claims from the previous run would suppress replies it should make.
	clearBotClaims(botId);
	clearAutomaticReplyEchoes(botId);
	clearTrackedReplies(botId);
	clearSquareForensics(botId);
	updateBotStatus(botId, "offline");
	botEvents.emit("bot_status", { botId, status: "offline" });
	if (wasRunning) logBotEvent(botId, "stopped", "หยุดบอทแล้ว");
	// A stopped session has no state worth retaining. Keeping a runtime for
	// every historical start/stop (or even every rejected API call) made this
	// map grow for the whole process lifetime; a future start creates a clean
	// attempt gate and listeners instead.
	runtimes.delete(botId);
	fastSquarePollSlots.release(botId);
	// A released fast slot may be claimed by a bot that previously used the
	// 100ms overflow path. Re-evaluate every remaining poller without changing
	// established slot owners.
	for (const [otherBotId, otherRuntime] of runtimes) {
		if (otherRuntime.client) syncFastSquarePollers(otherBotId);
	}
}

/**
 * Shuts off every bot a user has past their new quota, and reports which.
 *
 * Called the moment an admin lowers a quota. Leaving them running was the
 * old behaviour and it meant a customer who stopped paying for four bots
 * kept all four — the quota only blocked creating a fifth, which is not
 * what anyone selling this thought it did.
 *
 * They are stopped, never deleted. A bot holds a scanned LINE session and
 * its rules; deleting it would make paying again cost a fresh QR scan and a
 * rebuild, so lapsing is reversible by raising the quota back.
 *
 * `users` (and quota) are not sharded — any admin, on any worker process,
 * can reach this route — but the bots a quota change must stop are. Since
 * every bot of one owner always lives on the same worker (see
 * worker-scope.ts), a bot this process cannot reach here means this
 * process is not the one running that owner's bots at all: refuse the
 * whole change rather than stop the reachable half and silently leave the
 * rest running past quota with no error to explain why. The caller is
 * expected to run this before persisting the new quota, so a refusal here
 * leaves nothing partially applied.
 */
export function enforceBotQuota(userId: number, quota: number): Bot[] {
	const excess = overQuotaBots(userId, quota);
	if (excess.some((bot) => !inWorkerScope(bot.ownerUserId))) {
		throw new WorkerScopeError(
			"บอทบางตัวของผู้ใช้นี้อยู่ภายใต้ worker อื่น กรุณาปรับโควตาจากหน้าควบคุมของ worker ที่ดูแลบอทของผู้ใช้คนนี้",
		);
	}
	for (const bot of excess) {
		stopBot(bot.id);
		logBotEvent(bot.id, "over_quota", `ปิดอัตโนมัติ — เกินโควตาบอทของเจ้าของบัญชี (โควตาใหม่ ${quota} ตัว)`);
	}
	return excess;
}

function stopWatchdog(rt: BotRuntime): void {
	if (rt.watchdogTimer) {
		clearInterval(rt.watchdogTimer);
		rt.watchdogTimer = undefined;
	}
	stopSquareStallWatch(rt);
	stopSquareProactiveRefresh(rt);
}

function stopSquareStallWatch(rt: BotRuntime): void {
	if (!rt.squareStallTimer) return;
	clearInterval(rt.squareStallTimer);
	rt.squareStallTimer = undefined;
}

function stopSquareProactiveRefresh(rt: BotRuntime): void {
	if (!rt.squareRefreshTimer) return;
	clearInterval(rt.squareRefreshTimer);
	rt.squareRefreshTimer = undefined;
}

/**
 * Closes the shared push connection so `Polling.initLegyPusher`'s own
 * retry loop (already running, wired once via `client.listen()` in
 * `wireListeners`) notices and re-establishes both the talk and square
 * streams on its own — the same path an ordinary network blip already
 * takes. Deliberately not `reconnectAfterListenerLoss`: that rebuilds the
 * entire session (chat list, E2EE warm, fast-path prewarm, the works) for
 * a problem that is only ever this one connection, and every extra step
 * is a new place to fail — confirmed live, it once landed straight into a
 * `response.fullSyncResponse` crash mid-rebuild. It also flips bot_status
 * through connecting/online on every firing, which is what showed up as
 * the dashboard flickering red then green (and occasionally alerting
 * "offline" over Telegram).
 */
function refreshPushConnection(botId: number, client: Client, rt: BotRuntime): boolean {
	// Read the connection out before deciding anything: the old code closed
	// `conns[0]?` and armed the cooldown unconditionally, so on the (routine)
	// window where the pusher loop has spliced the connection out and not yet
	// replaced it, the optional-chain made the whole call a no-op while the
	// cooldown still recorded it as a recovery attempt. Five of those in a row
	// is the 68-second blind window this function now refuses to produce.
	const conn = client.base.push.conns[0];
	if (!conn) return false;
	rt.lastPushRefreshAt = Date.now();
	void conn.close().catch((err) => {
		// Swallowing this outright used to mean a broken recovery path (the
		// one mechanism meant to fix a silent stall) could itself fail
		// silently forever, on repeat, with nothing distinguishing it from
		// the stall it was trying to clear — the same anomaly kept
		// reappearing with no sign the fix was the part that was broken.
		recordAnomaly({
			botId,
			kind: "square_stalled",
			severity: "critical",
			detail: `พยายามปิด connection เพื่อเชื่อมต่อใหม่ แต่ปิดไม่สำเร็จ — ${err instanceof Error ? err.message : String(err)}`,
		});
	});
}

/**
 * Catches the one failure the noop watchdog above is blind to: OpenChat's
 * re-arm chain going silent while the credential and connection both stay
 * healthy (`noop` keeps passing, no `ListenerStopped` fires — nothing about
 * the session looks broken from either of those signals). Confirmed live:
 * a 226-second gap with zero square activity logged, bot still "online"
 * throughout, watchdog never once suspecting anything. Stays in place as
 * the backstop for whatever the proactive refresh below does not preempt.
 */
function startSquareStallWatch(botId: number, rt: BotRuntime): void {
	stopSquareStallWatch(rt);
	rt.squareStallTimer = setInterval(() => {
		const client = rt.client;
		if (!client || rt.stopRequested) return;
		if (!botHasSquareChats(botId)) return;

		const plan = planStallRecovery({
			now: Date.now(),
			lastSquareFetchAt: client.base.push.lastSquareFetchAt,
			lastRefreshAt: rt.lastPushRefreshAt,
			hasConnection: client.base.push.conns[0] !== undefined,
			failedRefreshes: rt.squareStallRefreshes ?? 0,
			rearmTried: rt.squareStallRearmTried === true,
		});

		if (plan.action === "healthy") {
			// The chain answered again, so whatever brought it back worked and
			// the next stall starts its escalation from zero.
			if (rt.squareStallRefreshes || rt.squareStallRearmTried) {
				console.log(
					`[bot ${botId}] [SQ_DIAG] square chain recovered ` +
						`(rearm=${rt.squareStallRearmTried === true}, refreshes=${rt.squareStallRefreshes ?? 0})`,
				);
				rt.squareStallRefreshes = 0;
				rt.squareStallRearmTried = false;
			}
			return;
		}
		if (plan.action === "wait") return;

		if (plan.action === "rearm") {
			// Marked before the await so a slow request cannot let the next
			// 5s tick fire a second one and double the chain.
			rt.squareStallRearmTried = true;
			console.log(`[bot ${botId}] [SQ_DIAG] square stalled ${Math.round(plan.staleMs)}ms — re-arming fetch chain in place (no teardown)`);
			void client.base.push.rearmSquareNow().catch((err) => {
				recordAnomaly({
					botId,
					kind: "square_stalled",
					severity: "warn",
					detail: `พยายามต่อคิวรับข้อความ OpenChat ใหม่ไม่สำเร็จ — ${err instanceof Error ? err.message : String(err)}`,
				});
			});
			return;
		}

		if (plan.action === "retry-soon") {
			// Deliberately loud and deliberately not throttled by the recovery
			// cooldown: this is the state that used to be invisible, and it is
			// self-limiting because the pusher loop replaces the connection
			// within its own few-second backoff.
			console.log(
				`[bot ${botId}] [SQ_DIAG] square stalled ${Math.round(plan.staleMs)}ms but no push connection exists to close — ` +
					`waiting for the pusher loop to rebuild it (retrying in ${SQUARE_STALL_CHECK_INTERVAL_MS}ms)`,
			);
			return;
		}

		if (plan.action === "refresh") {
			const attempted = refreshPushConnection(botId, client, rt);
			rt.squareStallRefreshes = (rt.squareStallRefreshes ?? 0) + 1;
			console.log(
				`[bot ${botId}] [SQ_DIAG] square stalled ${Math.round(plan.staleMs)}ms — ` +
					`closing push connection (attempt ${plan.attempt}, closed=${attempted})`,
			);
			recordAnomaly({
				botId,
				kind: "square_stalled",
				severity: "warn",
				detail: `OpenChat หยุดรับข้อความเงียบๆ มา ${Math.round(plan.staleMs)}ms ทั้งที่บอทดูเหมือนออนไลน์ปกติ — ปิด connection เดิมให้ตัวมันเองเชื่อมต่อใหม่ (ครั้งที่ ${plan.attempt})`,
			});
			return;
		}

		// rebuild — closing the connection has not brought the chain back, so
		// stop repeating a move that demonstrably is not working. Costs a full
		// session rebuild; a blind bot costs more.
		rt.squareStallRefreshes = 0;
		rt.squareStallRearmTried = false;
		console.log(
			`[bot ${botId}] [SQ_DIAG] square stalled ${Math.round(plan.staleMs)}ms after ${plan.attempts} refresh attempt(s) — rebuilding session`,
		);
		recordAnomaly({
			botId,
			kind: "square_stalled",
			severity: "critical",
			detail: `OpenChat ยังเงียบอยู่ ${Math.round(plan.staleMs)}ms หลังปิด connection ไปแล้ว ${plan.attempts} ครั้ง — กำลังสร้างเซสชันใหม่ทั้งหมด`,
		});
		void reconnectAfterListenerLoss(botId, rt, client);
	}, SQUARE_STALL_CHECK_INTERVAL_MS);
	rt.squareStallTimer.unref?.();
}

/**
 * Refreshes the push connection on our own schedule, ahead of the silent
 * stall the reactive watchdog above exists to catch — see
 * SQUARE_PROACTIVE_REFRESH_MS for why 15 minutes. Same underlying action
 * (`refreshPushConnection`) as the reactive path, just triggered by a
 * clock instead of an observed staleness.
 */
function startSquareProactiveRefresh(botId: number, rt: BotRuntime): void {
	stopSquareProactiveRefresh(rt);
	rt.lastPushRefreshAt = Date.now();
	rt.squareRefreshTimer = setInterval(() => {
		const client = rt.client;
		if (!client || rt.stopRequested) return;
		if (!botHasSquareChats(botId)) return;
		if (Date.now() - (rt.lastPushRefreshAt ?? 0) < SQUARE_PROACTIVE_REFRESH_MS) return;
		refreshPushConnection(botId, client, rt);
	}, SQUARE_PROACTIVE_CHECK_INTERVAL_MS);
	rt.squareRefreshTimer.unref?.();
}

/**
 * Periodically proves the session still works, and rebuilds it when it
 * does not.
 *
 * `noop` is the cheapest authenticated call available, so a failure means
 * the session itself is gone rather than a particular feature being
 * unavailable. Recovery reuses the normal login path, which prefers the
 * stored token and only asks for a QR scan when that is refused.
 */
function startWatchdog(botId: number, device: Device, rt: BotRuntime): void {
	stopWatchdog(rt);
	startSquareStallWatch(botId, rt);
	startSquareProactiveRefresh(botId, rt);
	rt.watchdogTimer = setInterval(() => {
		void (async () => {
			const client = rt.client;
			if (!client || rt.stopRequested) return;

			try {
				await client.base.talk.noop();
				if (rt.client !== client) return;
				rt.watchdogFailures = 0;
			} catch (err) {
				if (rt.client !== client) return;
				rt.watchdogFailures++;
				if (rt.watchdogFailures < WATCHDOG_FAILURES_BEFORE_RECOVERY) return;

				emitError(
					botId,
					new Error(
						`เซสชันขาดการเชื่อมต่อ (${rt.watchdogFailures} ครั้งติดกัน) — กำลังเชื่อมต่อใหม่: ${
							err instanceof Error ? err.message : String(err)
						}`,
					),
				);
				stopWatchdog(rt);
				rt.listenAbort?.abort();
				rt.listenAbort = undefined;
				rt.client = undefined;
				rt.watchdogFailures = 0;
				try {
					await beginLogin(botId, device);
				} catch (loginErr) {
					// beginLogin can throw before attemptLogin's own try block
					// (SessionAttemptGate rejecting a generation already in
					// flight, or a synchronous throw from an event listener) —
					// left unguarded, that left the bot with no client and no
					// watchdog while the dashboard kept showing its last known
					// status (usually "online"), recoverable only by a manual
					// stop/start. Mirrors reconnectAfterListenerLoss's own
					// try/catch around the identical call.
					updateBotStatus(botId, "offline");
					botEvents.emit("bot_status", { botId, status: "offline" });
					emitError(botId, loginErr);
				}
			}
		})();
	}, WATCHDOG_INTERVAL_MS);
	rt.watchdogTimer.unref?.();
}

export function deleteBotSession(botId: number): void {
	stopBot(botId);
	runtimes.delete(botId);
	// The DB rows are dropped below via deleteBot()'s cascade; the in-memory
	// timers armed for them are not, and would otherwise fire against a bot
	// that no longer has a runtime (harmless, but a pointless wakeup with a
	// confusing anomaly log behind it).
	for (const post of listScheduledPosts(botId)) disarmScheduledPostTimer(post.id);
	clearThrottle(botId);
	clearChatAccess(botId);
	lastFastPollReselect.delete(botId);
	clearBotAnomalies(botId);
	clearSquareRoles(botId);
	clearSquareSelfMidsForBot(botId);
	// Enqueued after every older storage write, so the writer worker cannot
	// resurrect session rows after the synchronous bot deletion below.
	void new SqliteStorage(botId).clear();
	clearSqliteStorageCache(botId);
	deleteBot(botId);
}

/**
 * Reports a bot-level failure to whoever is listening (the WS channel),
 * and always to the server log.
 *
 * Deliberately not emitted as the literal `"error"` event: Node's
 * EventEmitter special-cases that name and throws — crashing the whole
 * process — the instant it has zero listeners, which is exactly the
 * state `botEvents` is in whenever no dashboard tab is connected. A
 * transient push hiccup then took down every bot instead of just being
 * logged, which is how a normal `LegyPusherError` turned into an
 * unexplained backend restart (cold connections, a fresh QR wait) with
 * nothing in the log pointing at why.
 */
export function emitError(botId: number, err: unknown): void {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`[bot ${botId}] ${message}`);
	botEvents.emit("bot_error", { botId, message });
	logBotEvent(botId, "error", message);
}

/**
 * Log entries that mean the bot has stopped hearing something, rather
 * than routine protocol chatter.
 */
const FAILURE_LOG_TYPES = new Set([
	"SignOnResponseError",
	"PushResponseError",
	"LegyPusherError",
	"LegyPusherError_cannot_init",
	"TalkMessageError",
]);

/** Emitted by the client when a talk/square event loop stops unexpectedly. */
const LISTENER_STOPPED_LOG_TYPE = "ListenerStopped";

/**
 * Rebuilds a session whose event stream died while the credential stayed
 * valid. Guarded so the two streams failing together (the usual case, since
 * they share a connection) rebuild once rather than racing each other.
 */
async function reconnectAfterListenerLoss(botId: number, rt: BotRuntime, client: Client): Promise<void> {
	if (rt.stopRequested || rt.client !== client || rt.loginRun) return;
	const bot = getBot(botId);
	if (!bot) return;

	stopWatchdog(rt);
	rt.listenAbort?.abort();
	rt.listenAbort = undefined;
	rt.client = undefined;
	rt.watchdogFailures = 0;
	try {
		await beginLogin(botId, bot.device as Device);
	} catch (err) {
		emitError(botId, err);
	}
}

/** Delivers a per-room fetch through the exact same handlers as push. */
const fastDeliveredSquareEvents = new WeakSet<object>();
const INTERNAL_RECEIVED_AT = Symbol.for("linebot.internalReceivedAt");
const DECRYPT_MS = Symbol.for("linebot.decryptMs");
const RECEIVE_SOURCE = Symbol.for("linebot.receiveSource");

function deliverFastSquareEvent(client: Client, event: SquareEvent, receivedAt: number): void {
	fastDeliveredSquareEvents.add(event);
	const raw =
		event.type === "RECEIVE_MESSAGE"
			? event.payload.receiveMessage?.squareMessage
			: event.type === "SEND_MESSAGE"
				? event.payload.sendMessage?.squareMessage
				: event.type === "NOTIFICATION_MESSAGE"
					? event.payload.notificationMessage?.squareMessage
					: undefined;
	if (raw) {
		const message = new SquareMessage({ raw, client });
		const timed = message as unknown as Record<symbol, number | string>;
		// Plain assignments avoid three property-descriptor allocations on every
		// trigger. More importantly, start the reply before emitting the broader
		// Square event: its forensic listeners are observers and can run while the
		// already-dispatched request is crossing the network.
		timed[INTERNAL_RECEIVED_AT] = receivedAt;
		timed[DECRYPT_MS] = 0;
		timed[RECEIVE_SOURCE] = "dedicated-poll";
		client.emit("square:message", message);
	}
	client.emit("square:event", event);
	fastDeliveredSquareEvents.delete(event);
}

/**
 * Groups the bots that must not answer the same message as each other.
 *
 * An unowned bot gets a key of its own so it never shares a claim with
 * another unowned bot — those are unrelated accounts that happen to both
 * predate ownership, not a fleet.
 */
function replyOwnerKey(botId: number, ownerUserId = runtimes.get(botId)?.ownerUserId): string {
	return ownerUserId === null || ownerUserId === undefined ? `bot:${botId}` : `user:${ownerUserId}`;
}

/** Re-entrancy guard for the sibling nudge in `syncFastSquarePollers`. */
let nudgingSiblings = false;

/**
 * The OpenChats this bot may reply in, each with how busy it has been, in
 * the stable most-recently-joined-first order `selectFastPollRoom` expects
 * as its tie-break.
 */
function fastPollCandidates(botId: number): FastPollCandidate[] {
	const mids = enabledSquareChatMidsStmt.all(botId).map((row) => row.mid);
	if (mids.length <= 1) return mids.map((mid) => ({ mid, recentMessages: 0 }));
	const activity = new Map(
		squareRoomActivityStmt.all(botId, Date.now() - FAST_POLL_ACTIVITY_WINDOW_MS).map((row) => [row.target_mid, row.n] as const),
	);
	return mids.map((mid) => ({ mid, recentMessages: activity.get(mid) ?? 0 }));
}

/**
 * Points the bot's fast pollers (up to FAST_SQUARE_POLL_MAX_ROOMS of them)
 * at the OpenChats actually racing, and stops any poller on a room that is
 * no longer eligible. The normal push connection stays active on every
 * enabled room as a fallback; primary-bot.ts routes the actual send through
 * one designated answerer regardless of which sibling's poller caught it,
 * so siblings freely land on the same room — see fast-poll-room.ts.
 */
export function syncFastSquarePollers(botId: number): void {
	const rt = runtimes.get(botId);
	const client = rt?.client;
	const parentAbort = rt?.listenAbort;
	if (!rt || !client || !parentAbort) return;

	const pollers = (rt.fastSquarePollers ??= new Map<string, AbortController>());
	const current = [...pollers.keys()];
	const candidates = fastPollCandidates(botId).filter((candidate) => !rt.fastSquarePollBlocked?.has(candidate.mid));
	const chosen = FAST_SQUARE_POLL_ENABLED ? selectFastPollRooms(candidates, current, FAST_SQUARE_POLL_MAX_ROOMS) : [];
	const desired = new Set(chosen);
	let intervalMs = FAST_SQUARE_POLL_INTERVAL_MS;
	let releasedFastSlot = false;
	if (FAST_SQUARE_POLL_INTERVAL_MS < 100) {
		if (desired.size === 0) releasedFastSlot = fastSquarePollSlots.release(botId);
		else if (!fastSquarePollSlots.acquire(botId)) intervalMs = 100;
	}
	if (rt.fastSquarePollIntervalMs !== undefined && rt.fastSquarePollIntervalMs !== intervalMs) {
		for (const controller of pollers.values()) controller.abort();
		pollers.clear();
	}
	rt.fastSquarePollIntervalMs = intervalMs;

	for (const [mid, controller] of pollers) {
		if (desired.has(mid)) continue;
		controller.abort();
		pollers.delete(mid);
		// Logged because a silent move is indistinguishable from the fast path
		// having quietly stopped working in the room someone is watching.
		console.log(
			`[bot ${botId}] fast Square poll stopped: ${mid}` +
				`${chosen.length === 0 ? " (no eligible room)" : ` -> now on ${chosen.join(", ")}`}`,
		);
	}

	// A room this bot just left or took changes what its siblings should do,
	// and waiting for their own next tick would leave a room uncovered for up
	// to a minute. Guarded against the obvious cascade: the nudged sibling's
	// own call cannot nudge back.
	const changed = chosen.length !== current.length || chosen.some((mid) => !current.includes(mid));
	if (changed && !nudgingSiblings) {
		nudgingSiblings = true;
		try {
			const ownerKey = replyOwnerKey(botId);
			for (const otherBotId of [...runtimes.keys()]) {
				if (otherBotId === botId) continue;
				if (replyOwnerKey(otherBotId) !== ownerKey) continue;
				syncFastSquarePollers(otherBotId);
			}
		} finally {
			nudgingSiblings = false;
		}
	}

	for (const squareChatMid of desired) {
		if (pollers.has(squareChatMid)) continue;
		const controller = new AbortController();
		pollers.set(squareChatMid, controller);
		console.log(
			`[bot ${botId}] fast Square poll active: ${squareChatMid} ` +
				`workers=${FAST_SQUARE_POLL_WORKERS} ` +
				(FAST_SQUARE_POLL_WORKERS_REQUESTED === FAST_SQUARE_POLL_WORKERS
					? ""
					: `(requested ${FAST_SQUARE_POLL_WORKERS_REQUESTED}; capped at one dedicated cursor) `) +
				(FAST_SQUARE_POLL_MAX_ROOMS_REQUESTED === FAST_SQUARE_POLL_MAX_ROOMS
					? ""
					: `(requested ${FAST_SQUARE_POLL_MAX_ROOMS_REQUESTED} rooms; capped at one poll per session) `) +
				`interval=${intervalMs}ms` +
				(FAST_SQUARE_POLL_INTERVAL_MS < 100 && intervalMs >= 100
					? ` (fast slots full: ${fastSquarePollSlots.size}/${FAST_SQUARE_POLL_SLOTS})`
					: ""),
		);

		const worker = runFastSquarePoller({
			squareChatMid,
			signal: controller.signal,
			intervalMs,
			fetchEvents: (options, signal) => client.base.square.fetchSquareChatEvents({ ...options, signal }),
			onEvent: (event, receivedAt) => {
				if (rt.stopRequested || runtimes.get(botId)?.client !== client) return;
				deliverFastSquareEvent(client, event, receivedAt);
			},
			onError: (error, failures) => {
				if (isSquareAccessDenied(error)) {
					const blocked = (rt.fastSquarePollBlocked ??= new Set<string>());
					if (!blocked.has(squareChatMid)) {
						blocked.add(squareChatMid);
						const detail = "LINE ปฏิเสธสิทธิ์เข้าห้องนี้ — ตรวจสมาชิกห้อง แล้วกดเริ่ม/สแกน QR ใหม่ก่อนทดสอบอีกครั้ง";
						recordAnomaly({
							botId,
							kind: "square_access_denied",
							severity: "critical",
							chatMid: squareChatMid,
							detail,
						});
						emitError(botId, new Error(detail));
					}
					// Do not turn a permanent authorization failure into an endless
					// request stream. Another eligible room can take this budget.
					controller.abort();
					queueMicrotask(() => {
						if (!rt.stopRequested && runtimes.get(botId)?.client === client) syncFastSquarePollers(botId);
					});
					return;
				}
				// First failure and powers of two are enough to diagnose a broken
				// route without making logging itself the hottest loop in the process.
				if (failures === 1 || (failures & (failures - 1)) === 0) {
					console.error(
						`[bot ${botId}] fast Square poll ${squareChatMid} worker=1 ` +
							`failed (${failures}): ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			},
		});
		void worker.finally(() => {
			if (pollers.get(squareChatMid) === controller) pollers.delete(squareChatMid);
		});
	}
	if (releasedFastSlot) scheduleFastSlotRebalance();
}

/**
 * Re-runs the room choice while the bot is live, so a room that gets busy
 * after the bot started can take the poller without waiting for a restart or
 * for someone to toggle something.
 *
 * Driven by incoming OpenChat messages rather than a timer: the push
 * connection stays subscribed to *every* enabled room, so traffic in a room
 * the poller is not on still arrives here — and when nothing is arriving
 * anywhere there is nothing to reconsider. Throttled because the choice
 * costs a grouped scan of `messages_in` and cannot usefully change between
 * two messages a second apart.
 */
const FAST_POLL_RESELECT_INTERVAL_MS = Math.max(5_000, Number(process.env.SQUARE_FAST_POLL_RESELECT_INTERVAL_MS ?? 60_000));
const lastFastPollReselect = new Map<number, number>();

function maybeReselectFastPollRoom(botId: number): void {
	const now = performance.now();
	const last = lastFastPollReselect.get(botId);
	if (last !== undefined && now - last < FAST_POLL_RESELECT_INTERVAL_MS) return;
	lastFastPollReselect.set(botId, now);
	syncFastSquarePollers(botId);
}

function wireListeners(botId: number, client: Client, rt: BotRuntime): void {
	const abort = new AbortController();
	rt.listenAbort = abort;
	const onMessage = (message: TalkMessage) => {
		if (rt.stopRequested || runtimes.get(botId)?.client !== client) return;
		void handleIncoming(botId, "talk", message).catch((err) => emitError(botId, err));
	};
	const onSquareMessage = (message: SquareMessage) => {
		if (rt.stopRequested || runtimes.get(botId)?.client !== client) return;
		void handleIncoming(botId, "square", message).catch((err) => emitError(botId, err));
		// Deferred a tick on purpose: `handleIncoming` returns at its first
		// await with the reply still in flight, and the room choice reads the
		// database. Cheap is not free, and nothing in this codebase gets to
		// run between a trigger and its answer without earning it.
		setImmediate(() => {
			if (rt.stopRequested || runtimes.get(botId)?.client !== client) return;
			maybeReselectFastPollRoom(botId);
		});
	};
	const onSquareEvent = (event: SquareEvent) => {
		if (rt.stopRequested || runtimes.get(botId)?.client !== client) return;
		// Passive only: this copies the event that push/room-poll already paid
		// for and never makes a forensic LINE request of its own. Defer parsing
		// until the current event-delivery stack has started the reply request;
		// even the small Object.values/timeline work must stay behind the send.
		const forensicSource = fastDeliveredSquareEvents.has(event) ? "dedicated-poll" : "normal-poll";
		queueMicrotask(() => {
			if (rt.stopRequested || runtimes.get(botId)?.client !== client) return;
			observeSquareForensicEvent(botId, event, forensicSource);
		});
		if (event.type !== "NOTIFIED_DESTROY_MESSAGE") return;
		const destroyed = event.payload.notifiedDestroyMessage;
		if (!destroyed) return;
		const claim = claimResend(botId, destroyed.squareChatMid, destroyed.messageId);
		// Recorded whether or not it was ours. A destroy for someone else's
		// message still proves something in the room deletes messages; the
		// *absence* of any row here while our replies vanish proves the
		// opposite — nothing is deleting them and the account is being
		// silenced instead. Those need different fixes, so they must not be
		// guessed apart.
		const destroyDetail = `ลบข้อความ id ${destroyed.messageId} — ${
			claim ? `เป็นของบอทเรา กำลังส่งซ้ำครั้งที่ ${claim.attempt}/${MAX_RESENDS}` : "ไม่ใช่ของบอทเรา (หรือส่งซ้ำครบโควตา/หมดอายุแล้ว)"
		}`;
		recordAnomaly({
			botId,
			kind: "reply_destroyed",
			severity: claim ? "critical" : "info",
			chatMid: destroyed.squareChatMid,
			detail: destroyDetail,
		});
		if (claim) sendAlert("reply_blocked", botId, getBot(botId)?.name ?? String(botId), destroyDetail);
		if (!claim) return;
		void resendDestroyedReply(botId, client, destroyed.squareChatMid, claim.text, claim.attempt);
	};
	// The push layer reports its failures as log entries and otherwise
	// carries on. Surfacing them is what turns "the bot went quiet" from
	// something noticed hours later into something visible immediately.
	const onLog = ({ type, data }: { type: string; data: unknown }) => {
		if (rt.stopRequested || runtimes.get(botId)?.client !== client) return;
		if (type === LISTENER_STOPPED_LOG_TYPE) {
			// A dead event stream is the one failure the watchdog cannot see:
			// its probe only proves the *credential* still works, which it does
			// while the bot sits online hearing nothing. Reconnect on the
			// report instead of waiting for a health check that will pass.
			if (rt.stopRequested) return;
			recordAnomaly({
				botId,
				kind: "listener_stopped",
				severity: "critical",
				detail: `สตรีมรับข้อความหยุดทำงาน (${JSON.stringify(data)}) — บอทจะไม่เห็นข้อความใหม่จนกว่าจะเชื่อมต่อใหม่สำเร็จ`,
			});
			emitError(botId, new Error(`หยุดรับข้อความ (${JSON.stringify(data)}) — กำลังเชื่อมต่อใหม่`));
			void reconnectAfterListenerLoss(botId, rt, client);
			return;
		}
		if (type.startsWith("[SQ_DIAG]")) {
			// Opt-in diagnostic (LINEJS_SQUARE_DIAGNOSTICS=1), never a failure.
			console.log(`[bot ${botId}] ${type}`, data);
			return;
		}
		if (!FAILURE_LOG_TYPES.has(type)) return;
		emitError(botId, new Error(`push: ${type} — ${JSON.stringify(data)}`));
	};
	client.on("message", onMessage);
	client.on("square:message", onSquareMessage);
	client.on("square:event", onSquareEvent);
	client.base.on("log", onLog);
	// These handlers close over `botId`, so leaving them attached to a
	// replaced session lets a dead client keep speaking for a live bot:
	// reporting its own teardown as a dashboard error, and — via
	// LISTENER_STOPPED — asking for a reconnect the live session does not
	// need. Detaching is what makes a torn-down session actually silent.
	abort.signal.addEventListener("abort", () => {
		for (const controller of rt.fastSquarePollers?.values() ?? []) controller.abort();
		rt.fastSquarePollers?.clear();
		client.off("message", onMessage);
		client.off("square:message", onSquareMessage);
		client.off("square:event", onSquareEvent);
		client.base.off("log", onLog);
	});
	client.listen({ talk: true, square: true, signal: abort.signal });
	syncFastSquarePollers(botId);
	// Admission is slot-based. Re-evaluating established pollers is safe: they
	// retain their slots, while this new bot receives only remaining capacity.
	for (const [otherBotId, otherRuntime] of runtimes) {
		if (otherBotId !== botId && otherRuntime.client) syncFastSquarePollers(otherBotId);
	}
}

/**
 * Optional jitter before answering a destroyed reply — defaults to 0. The
 * resend has to beat the same race the original reply was already winning,
 * so nothing here should cost more time than the unavoidable round trip to
 * LINE. Only set this if a rival's delete bot turns out to be matching on
 * reply *timing* rather than content — that is a real cost, spend it
 * deliberately, not by default. See reply-defense.ts.
 */
const RESEND_JITTER_MIN_MS = Math.max(0, Number(process.env.REPLY_DEFENSE_JITTER_MIN_MS ?? 0));
const RESEND_JITTER_MAX_MS = Math.max(RESEND_JITTER_MIN_MS, Number(process.env.REPLY_DEFENSE_JITTER_MAX_MS ?? 0));

/**
 * Fires when a Square moderator destroys one of our own auto-replies.
 * Answers with the same text — lightly varied so a literal-match deletion
 * rule does not recognize the retry — as fast as the transport allows: this
 * calls the client directly rather than going through `sendTimed`, so there
 * is no extra hop beyond admission control and the network round trip
 * itself (the same warmed dispatch connection an original reply uses —
 * `runWithFastPath` only wraps a trace for the dashboard, it is not what
 * makes a send fast). Still goes through the normal send throttle so this
 * cannot itself look like spam to LINE; a rate-limited moment is a skipped
 * resend, not a forced one.
 */
async function resendDestroyedReply(botId: number, client: Client, squareChatMid: string, text: string, attempt: number): Promise<void> {
	if (RESEND_JITTER_MAX_MS > 0) {
		const jitterMs = RESEND_JITTER_MIN_MS + Math.random() * (RESEND_JITTER_MAX_MS - RESEND_JITTER_MIN_MS);
		await new Promise<void>((resolve) => setTimeout(resolve, jitterMs));
		if (runtimes.get(botId)?.client !== client) return;
	}

	if (!tryAcquireSend(botId).allowed) {
		recordAnomaly({
			botId,
			kind: "send_dropped",
			severity: "warn",
			chatMid: squareChatMid,
			detail: `ส่งซ้ำไม่ได้ ติดลิมิตการส่งของเราเอง (SEND_MAX_PER_WINDOW)`,
		});
		return;
	}
	try {
		const result = await client.base.square.sendMessage({
			squareChatMid,
			text: varyText(text, attempt),
			fastAck: false,
		});
		if (runtimes.get(botId)?.client !== client) return;
		noteSquareSendResult(botId, client, squareChatMid, result, text, attempt);
		recordAnomaly({
			botId,
			kind: "reply_resent",
			severity: "warn",
			chatMid: squareChatMid,
			detail: `ส่งซ้ำสำเร็จ ครั้งที่ ${attempt}/${MAX_RESENDS}`,
		});
	} catch (err) {
		if (runtimes.get(botId)?.client !== client) return;
		recordAnomaly({
			botId,
			kind: "send_failed",
			severity: "critical",
			chatMid: squareChatMid,
			detail: `ส่งซ้ำไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`,
		});
		emitError(botId, err);
	}
}

/** LINE's own verdict on a message we just sent, when it bothers to give one. */
function isPlainlySentState(state: SquareMessageState | undefined): boolean {
	return state === undefined || state === 1 || state === "SENT";
}

interface CreatedSquareSend {
	message: { id: string; createdTime?: unknown };
	state?: SquareMessageState;
}

function createdSquareSend(result: unknown): CreatedSquareSend | undefined {
	if (!result || typeof result !== "object" || !("createdSquareMessage" in result)) return undefined;
	return (result as { createdSquareMessage: CreatedSquareSend }).createdSquareMessage;
}

/** Reads only the one field needed inside the measured window. */
function squareSendLineCreatedTime(result: unknown): number | undefined {
	return toLineEpochMs(createdSquareSend(result)?.message.createdTime);
}

/**
 * Records what LINE actually did with a Square reply we just sent, and arms
 * the destroy-resend for it.
 *
 * A send that resolves without throwing is not proof the room shows it.
 * LINE returns the message it created along with its own state, and an
 * account the room has silenced gets `FORBIDDEN` (or a message that is
 * already `DELETED`) back from a call that otherwise looks completely
 * successful — the dashboard would still record ok=1 at 200ms. That is the
 * difference between "a rival deleted it a moment later", which resending
 * fights, and "this account is not allowed to speak here", which no amount
 * of resending can fix. Recorded rather than inferred.
 */
function noteSquareSendResult(
	botId: number,
	client: Client,
	squareChatMid: string,
	result: unknown,
	text: string,
	attempt = 0,
	trace?: FastPathTrace,
): void {
	const created = createdSquareSend(result);
	if (!created) return;
	const messageId = created.message.id;
	// LINE's stamp on our own reply. Paired with the stamp it put on the
	// trigger (and on any rival's reply), this is what settles who was
	// actually first without trusting either side's clock.
	if (trace) trace.lineCreatedTime = toLineEpochMs(created.message.createdTime);
	trackSentReply(botId, squareChatMid, messageId, text, attempt);
	if (!isPlainlySentState(created.state)) {
		const rejectedDetail =
			`LINE รับข้อความแล้วแต่ตอบสถานะ ${JSON.stringify(created.state)} (id ${messageId}) — ` +
			`บัญชีบอทน่าจะถูกจำกัดสิทธิ์/ปิดปากในห้องนี้ ส่งซ้ำกี่ครั้งก็จะไม่ขึ้น`;
		recordAnomaly({
			botId,
			kind: "send_rejected",
			severity: "critical",
			chatMid: squareChatMid,
			detail: rejectedDetail,
		});
		sendAlert("reply_blocked", botId, getBot(botId)?.name ?? String(botId), rejectedDetail);
	}
	// LINE calling a send `SENT` is not the same as the room having it. Watch
	// the already-running event streams at 0.5/1/2 seconds after this send.
	// This replaced the old BACKWARD fetch: no diagnostic request can queue
	// behind or compete with the latency-sensitive room poll lane.
	if (!VERIFY_SENDS_ENABLED) return;
	const acceptedLineCreatedTime = toLineEpochMs(created.message.createdTime);
	const armTimer = setImmediate(() => {
		if (runtimes.get(botId)?.client !== client) return;
		armSquareReplyForensics({
			botId,
			squareChatMid,
			messageId,
			acceptedState: created.state,
			acceptedLineCreatedTime,
			onFinal: (visibility) => {
				if (runtimes.get(botId)?.client !== client) return;
				// `pending` means no later event arrived, so absence is inconclusive.
				// Once a later event is visible, the stream has advanced past our LINE
				// timestamp and an absent id is real evidence rather than a timeout.
				if (visibility.presence !== "missing_after_later_event") return;
				const invisibleDetail =
					`ส่งสำเร็จ แต่ event stream ผ่านไปถึงข้อความใหม่กว่าแล้วไม่พบข้อความเรา ` +
					`(id ${messageId}, checkpoint ${visibility.checkpointMs}ms, timeline ${JSON.stringify(visibility.timeline)})`;
				recordAnomaly({
					botId,
					kind: "reply_invisible",
					severity: "critical",
					chatMid: squareChatMid,
					detail: invisibleDetail,
				});
				sendAlert("reply_blocked", botId, getBot(botId)?.name ?? String(botId), invisibleDetail);
				if (!RESEND_WHEN_INVISIBLE) return;
				const claim = claimResend(botId, squareChatMid, messageId);
				if (claim) void resendDestroyedReply(botId, client, squareChatMid, claim.text, claim.attempt);
			},
		});
	});
	armTimer.unref?.();
}

/**
 * Our own member mid inside each OpenChat, keyed by `${botId}:${squareChatMid}`.
 *
 * A square member mid is per-square and unrelated to the account's
 * profile mid, so recognising our own messages there needs a lookup.
 * Resolved once per chat when a session starts (see refreshChatsCache) so
 * the check on the hot path is a map read.
 *
 * The key includes `botId` because a square chat mid is only unique within
 * one LINE account's view of it — two different bot accounts (different
 * tenants) can both be joined to the same OpenChat, each with their own
 * member mid there. Keying by chat mid alone let whichever bot resolved
 * first overwrite the entry for every other bot in that chat, so a bot's
 * own outgoing messages could be misclassified as external (letting a
 * matching rule reply to itself) or another tenant's messages silently
 * dropped as "own".
 */
const squareSelfMids = new Map<string, string>();

/** Square chats whose self-mid lookup is already in flight, same key shape. */
const squareSelfMidPending = new Set<string>();

/** Drops every cached self-mid for a bot being deleted. */
function clearSquareSelfMidsForBot(botId: number): void {
	const prefix = squareSelfMidKey(botId, "");
	for (const key of squareSelfMids.keys()) {
		if (key.startsWith(prefix)) squareSelfMids.delete(key);
	}
	for (const key of squareSelfMidPending) {
		if (key.startsWith(prefix)) squareSelfMidPending.delete(key);
	}
}

/**
 * True when a message was sent by this bot.
 *
 * LINE echoes the account's own messages back through the same stream it
 * delivers everyone else's. Without this check a reply whose text happens
 * to match a rule answers itself, forever.
 */
function isOwnMessage(botId: number, surface: Surface, message: TalkMessage | SquareMessage, chatMid: string): boolean {
	if (surface === "talk") return (message as TalkMessage).isMyMessage;

	const selfMid = squareSelfMids.get(squareSelfMidKey(botId, chatMid));
	if (selfMid !== undefined) return selfMid === message.from.id;

	// Reachable only for a chat joined after this session started. Resolve
	// it in the background rather than holding up the reply: the lookup
	// finishes long before an answer of ours could echo back, and treating
	// an unknown chat as "not ours" errs toward answering rather than
	// staying silent.
	// Starting an async lookup executes synchronously until its first await.
	// Put that setup behind the current reply dispatch so a newly joined
	// OpenChat cannot charge its first lookup to the answer path.
	queueMicrotask(() => void fillSquareSelfMid(botId, chatMid));
	return false;
}

async function fillSquareSelfMid(botId: number, squareChatMid: string): Promise<void> {
	const key = squareSelfMidKey(botId, squareChatMid);
	if (squareSelfMids.has(key) || squareSelfMidPending.has(key)) return;
	const runtime = runtimes.get(botId);
	const client = runtime?.client;
	if (!client) return;

	squareSelfMidPending.add(key);
	try {
		await resolveSquareSelfMids(client, botId, [squareChatMid]);
	} finally {
		squareSelfMidPending.delete(key);
	}
}

function messageIdOf(surface: Surface, message: TalkMessage | SquareMessage): string {
	return surface === "talk" ? String((message as TalkMessage).raw.id) : String((message as SquareMessage).raw.message.id);
}

interface IncomingRunOptions {
	/** Negative/shadow id used only by the startup RAM warmup. */
	prewarmGuardBotId?: number;
}

async function handleIncoming(
	botId: number,
	surface: Surface,
	message: TalkMessage | SquareMessage,
	options?: IncomingRunOptions,
): Promise<void> {
	if (!shouldProcessIncomingMessage(botId, surface, message)) return;
	const prewarmGuardBotId = options?.prewarmGuardBotId;
	const messageId = messageIdOf(surface, message);

	// The fast Square poller races the ordinary push connection on purpose
	// (see fast-square-poller.ts) — whichever sees a trigger first should
	// win. `claimReply` already made the *send* exactly-once between them,
	// but nothing gated rule matching, the live-feed entry, or the durable
	// `messages_in` row: a message delivered over both paths ran all of that
	// twice. Checked here, before any of it starts, using the same id both
	// paths agree on. Skipped for prewarm — its probes carry synthetic,
	// always-unique ids and are never a real race.
	if (prewarmGuardBotId === undefined && !claimIncomingMessage(botId, surface, messageId)) {
		return;
	}

	const targetMid = message.to.id;
	const text = message.text ?? "";
	if (isOwnMessage(botId, surface, message, targetMid)) {
		if (!isOwnerTestingEnabled(botId)) return;
		if (isAutomaticReplyEcho(botId, surface, targetMid, text, messageId)) return;
	}

	// The half of the race our own timings never covered: how late LINE
	// handed us the trigger. A reply cannot be first if it started last, and
	// every other number here begins counting only after this delay is
	// already spent. Measured for real messages only — a prewarm probe has
	// no LINE timestamp to be late against.
	const inboundMs = prewarmGuardBotId === undefined ? inboundDelayMs(surface, message) : undefined;
	if (isSlowInbound(inboundMs)) {
		recordAnomaly({
			botId,
			kind: "inbound_slow",
			severity: "warn",
			chatMid: targetMid,
			detail: `LINE ส่งข้อความถึงเราช้า ${inboundMs.toFixed(0)}ms หลังผู้ใช้พิมพ์ — เวลานี้หมดไปก่อนบอทจะเริ่มทำงาน (ค่าตอบสนองของบอทเองยังปกติ)`,
		});
	}

	// Match before announcing. The dashboard feed is a spectator; making
	// the reply wait behind its listeners would put UI work in front of
	// the only thing this bot is judged on.
	const matchStart = performance.now();
	const rule = matchRule(getCompiledRules(botId), text, surface);
	const matchMs = rule ? performance.now() - matchStart : 0;
	const runtime = runtimes.get(botId);
	const client = runtime?.client;
	const guardBotId = prewarmGuardBotId ?? botId;
	let replyPromise: Promise<void> | undefined;
	// Ordered deliberately: the per-bot claim is checked first because it is
	// the cheaper of the two and rejects the ordinary push/poll duplicate,
	// and the shared one is only consumed by a bot that would genuinely have
	// answered. Claiming the room from a bot with no matching rule would
	// silence the sibling that did have one.
	if (
		rule &&
		client &&
		claimReply(guardBotId, targetMid, rule.id, messageId) &&
		(prewarmGuardBotId !== undefined || claimRoomAnswer(replyOwnerKey(botId, runtime?.ownerUserId), botId, targetMid, messageId))
	) {
		const timedMessage = message as unknown as Record<symbol, number | string | undefined>;
		const stampedReceivedAt = timedMessage[INTERNAL_RECEIVED_AT];
		const stampedDecryptMs = timedMessage[DECRYPT_MS];
		const stampedReceiveSource = timedMessage[RECEIVE_SOURCE];
		const trace: FastPathTrace = {
			botId,
			surface,
			source: "auto",
			receivedAt: typeof stampedReceivedAt === "number" ? stampedReceivedAt : matchStart,
			receiveSource:
				stampedReceiveSource === "dedicated-poll" ? "dedicated-poll" : stampedReceiveSource === "normal-poll" ? "normal-poll" : "push",
			inboundMs,
			decryptMs: typeof stampedDecryptMs === "number" ? stampedDecryptMs : 0,
			matchMs,
			admissionMs: 0,
			protocolPrepMs: 0,
			relayEncodeMs: 0,
			goPrepMs: 0,
			upstreamCalls: 0,
			upstreamMs: 0,
		};
		// Real (non-prewarm) Square sends are tracked by message id so a
		// moderator destroying this exact reply can be answered — see
		// reply-defense.ts.
		const isTrackableSquareSend = surface === "square" && prewarmGuardBotId === undefined;
		// This bot still won the detection race, but the send itself goes out
		// under whichever bot is this room's designated answerer, so the room
		// only ever sees one identity reply instead of a different account
		// each time — see primary-bot.ts. Skipped for prewarm, which measures
		// this exact bot's own send path. Falls back to the detecting bot's
		// own (already-verified-live) client if the primary is not connected
		// right now — answering under the "wrong" name beats not answering.
		const primaryBotId = isTrackableSquareSend ? primaryBotIdFor(botId, targetMid, runtime?.ownerUserId) : undefined;
		const primaryClient = primaryBotId !== undefined ? runtimes.get(primaryBotId)?.client : undefined;
		const sendingBotId = primaryClient ? primaryBotId! : botId;
		const sendingClient = primaryClient ?? client;
		// Repeats of the same answer go out byte-different (invisibly), so
		// nothing downstream can key on "the bot's message is exactly this
		// string". Prewarm keeps the literal text — it measures the real
		// send path and must not drift from it.
		const outgoingText = prewarmGuardBotId === undefined ? uniquifyReply(sendingBotId, targetMid, rule.replyText) : rule.replyText;
		// Echo suppression compares against what actually went out, not the
		// rule's text, or a varied reply would come back looking like a
		// stranger's message and answer itself. Checked and tracked against
		// the sending bot: its own account is what will see this reply come
		// back as an incoming event, never the detecting bot's when the two differ.
		const cancelEchoTracking =
			prewarmGuardBotId === undefined && isOwnerTestingEnabled(sendingBotId)
				? trackAutomaticReply(sendingBotId, surface, targetMid, outgoingText)
				: undefined;
		let completedSquareResult: unknown;
		replyPromise = sendTimed(
			// The rate limiter and anomaly log below key off this id — it must
			// be whichever account is actually about to make the network call,
			// or a busy fleet of secondaries could drive the primary's send
			// rate past its own limiter without that limiter ever seeing it.
			sendingBotId,
			surface,
			targetMid,
			rule.replyText,
			"auto",
			async () => {
				const result = await sendReply(sendingClient, surface, message, outgoingText);
				if (isTrackableSquareSend) {
					completedSquareResult = result;
					trace.lineCreatedTime = squareSendLineCreatedTime(result);
				}
				return result;
			},
			trace,
			prewarmGuardBotId,
		).then((sent) => {
			if (!sent) {
				cancelEchoTracking?.();
				return;
			}
			// Visibility/destroy bookkeeping is post-send observation. Keeping it
			// after sendTimed has closed and recorded the stopwatch preserves every
			// diagnostic without charging the reply race for Map/timer/log work.
			if (isTrackableSquareSend) {
				noteSquareSendResult(sendingBotId, sendingClient, targetMid, completedSquareResult, rule.replyText);
			}
		});
	}

	if (prewarmGuardBotId === undefined) {
		const ts = Date.now();
		// createdTime rides along so the feed can time *other* bots in the
		// room the same way it times ours — a rival's reply is just an
		// incoming message, and LINE's stamp is the one clock both share.
		// fromMid is what makes that safe to act on: without knowing the
		// sender, "the same person typed again" and "a rival answered" are
		// the same shape — one message following another.
		const senderMid = message.from.id;
		const lineCreatedTime = lineCreatedTimeOf(surface, message);
		botEvents.emit("message_in", { botId, surface, text, targetMid, ts, createdTime: lineCreatedTime, fromMid: senderMid });
		// Durable copy for the live feed, so a dashboard refresh (or a backend
		// restart) no longer starts from an empty panel. Queued to the
		// write-behind worker rather than inserted here: this runs while the
		// reply is still in flight below, and the reply path is the one thing
		// that must never wait on a disk write.
		enqueueMessageIn({ botId, ts, surface, targetMid, text, createdTime: lineCreatedTime, fromMid: senderMid });
	}
	await replyPromise;
}

export async function testSend(botId: number, surface: Surface, targetMid: string, text: string): Promise<void> {
	const client = runtimes.get(botId)?.client;
	if (!client) throw new Error('บอทนี้ยังไม่ได้เข้าสู่ระบบ — กด "เริ่ม" ก่อน');
	const admission = tryAcquireSend(botId);
	if (!admission.allowed) {
		throw new Error(`ถึงขีดจำกัดการส่ง — ลองใหม่ใน ${Math.ceil(admission.retryAfterMs / 1000)} วินาที`);
	}
	// Sends straight to the mid. Resolving it to a Chat/SquareChat object
	// first would add a full round trip to LINE that the auto-reply path
	// never pays, making the P95 on the dashboard measure something the
	// bot does not actually do when it races.
	const sent = await sendTimed(
		botId,
		surface,
		targetMid,
		text,
		"test",
		() =>
			surface === "talk"
				? // Match the production auto-reply path. The previous full-Thrift
					// test went through LEGY and added ~120ms of local preparation that
					// an actual compact `/CA5` reply never pays.
					client.base.talk.sendCompactMessage({ to: targetMid, text, fastAck: true })
				: client.base.square.sendMessage({ squareChatMid: targetMid, text, fastAck: false }),
		undefined,
		undefined,
		true,
	);
	if (!sent) {
		throw new Error("ข้อความถูกยกเลิกโดยตัวป้องกัน LINE block — กรุณารอให้พ้นช่วงจำกัด");
	}
}

// ---- Scheduled posts: the "no keyword" rule --------------------------------
//
// A post with no keyword to match — it fires because a wall-clock time
// (Asia/Bangkok) was reached, not because anyone typed anything. Each
// pending post gets its own setTimeout armed for the exact millisecond it's
// due rather than a coarse polling loop: the entire point of the feature is
// firing "เป๊ะ" (exactly) at the chosen instant, the same precision this
// file already spends on racing a reply to a real message.
const scheduledPostTimers = new Map<number, ReturnType<typeof setTimeout>>();
// setTimeout silently clamps delays above this (~24.8 days) to fire almost
// immediately; a post scheduled further out re-arms itself in stages instead
// of firing early.
const MAX_TIMEOUT_MS = 2_147_483_647;
// How late a post's time is allowed to be found — after a restart, or a
// timer callback that itself got delayed — before it counts as missed
// rather than fired late. A "first to post" race lost by seconds was never
// won, so a stale post is dropped rather than sent anyway.
const SCHEDULED_POST_GRACE_MS = 5_000;

/** Pure ownership decision used by the timer runner and focused tests. */
export function scheduledPostBelongsToThisWorker(botId: number): boolean {
	const bot = getBot(botId);
	return !!bot && inWorkerScope(bot.ownerUserId);
}

export function disarmScheduledPostTimer(id: number): void {
	const timer = scheduledPostTimers.get(id);
	if (timer) {
		clearTimeout(timer);
		scheduledPostTimers.delete(id);
	}
}

function armScheduledPostTimer(post: ScheduledPost): void {
	disarmScheduledPostTimer(post.id);
	if (!scheduledPostBelongsToThisWorker(post.botId)) return;
	const delay = post.runAt - Date.now();
	if (delay > MAX_TIMEOUT_MS) {
		const timer = setTimeout(() => armScheduledPostTimer(post), MAX_TIMEOUT_MS);
		timer.unref?.();
		scheduledPostTimers.set(post.id, timer);
		return;
	}
	const timer = setTimeout(() => void fireScheduledPost(post), Math.max(0, delay));
	timer.unref?.();
	scheduledPostTimers.set(post.id, timer);
}

/** Re-reads the post fresh at fire time and sends it — or records why it didn't. */
async function fireScheduledPost(armed: ScheduledPost): Promise<void> {
	scheduledPostTimers.delete(armed.id);
	// The armed snapshot can be stale by now (edited, disabled, or deleted in
	// the gap between arming and firing) — the DB row is the truth.
	const post = getScheduledPost(armed.botId, armed.id);
	if (!post || !post.enabled || post.sentAt !== null) return;
	// Scope can only change on restart in production, but checking again makes
	// a stale timer fail harmlessly in tests/manual env changes and protects
	// future dynamic routing work. A non-owner must not disable this shared row.
	if (!scheduledPostBelongsToThisWorker(post.botId)) return;

	const lateBy = Date.now() - post.runAt;
	const client = runtimes.get(post.botId)?.client;
	if (!client || lateBy > SCHEDULED_POST_GRACE_MS) {
		disableScheduledPost(post.id);
		recordAnomaly({
			botId: post.botId,
			kind: "scheduled_post_missed",
			severity: "warn",
			chatMid: post.targetMid,
			detail: !client
				? "ถึงเวลาโพสตามกำหนดแต่บอทออฟไลน์ — ปิดรายการนี้แล้ว ตั้งเวลาใหม่เมื่อบอทออนไลน์"
				: `ถึงเวลาโพสตามกำหนดช้าไป ${Math.round(lateBy)}ms — ปิดรายการนี้แล้ว`,
		});
		return;
	}

	// Same direct-to-mid send testSend uses (no incoming message exists to
	// reply to here), synchronous non-blocking admission: a scheduled post
	// either goes out right now or is dropped, never queued behind a cooldown
	// — waiting would defeat the entire point of an exact-time post.
	const sent = await sendTimed(post.botId, post.surface, post.targetMid, post.text, "test", () =>
		post.surface === "talk"
			? client.base.talk.sendCompactMessage({ to: post.targetMid, text: post.text, fastAck: true })
			: client.base.square.sendMessage({ squareChatMid: post.targetMid, text: post.text, fastAck: false }),
	);
	if (sent) {
		markScheduledPostSent(post.id, Date.now());
		logBotEvent(post.botId, "scheduled_post_sent", `โพสตามเวลาแล้ว: ${post.text.slice(0, 80)}`);
	} else {
		disableScheduledPost(post.id);
		// tryAcquireSend already logged send_dropped/anomaly for the block
		// itself (see sendTimed); this just closes out the post so it does
		// not sit "pending" forever after the one shot it gets is spent.
	}
}

/** Re-arms (or disarms) one post's timer from its current DB row — call after any create/update/toggle. */
export function syncScheduledPostTimer(botId: number, id: number): void {
	disarmScheduledPostTimer(id);
	if (!scheduledPostBelongsToThisWorker(botId)) return;
	const post = getScheduledPost(botId, id);
	if (post && post.enabled && post.sentAt === null) armScheduledPostTimer(post);
}

/** Rebuilds every pending post's timer after a restart. */
function startScheduledPostRunner(): void {
	for (const post of listAllPendingScheduledPosts()) {
		if (scheduledPostBelongsToThisWorker(post.botId)) armScheduledPostTimer(post);
	}
}

// scheduledPostTimers (and everything startScheduledPostRunner touches) is
// now initialized — see the comment on the earlier NODE_ENV block for why
// this cannot run up there instead.
if (process.env.NODE_ENV !== "test") {
	startScheduledPostRunner();
}

/** Warms a newly created/edited rule while the dashboard request is active. */
export async function prewarmReplyText(botId: number, rawText: string): Promise<void> {
	const client = runtimes.get(botId)?.client;
	if (!client) return;
	const text = clampWarmText(rawText);
	await client.base.prewarmHotRequests(async () => {
		for (let pass = 0; pass < 3; pass++) {
			for (const prefix of ["u", "r", "c"] as const) {
				await client.base.talk.sendCompactMessage({
					to: `${prefix}${"0".repeat(32)}`,
					text,
					fastAck: true,
				});
			}
			await client.base.square.sendMessage({
				squareChatMid: `m${"0".repeat(32)}`,
				text,
				relatedMessageId: `warm-rule-${pass}`,
				fastAck: true,
			});
		}
	});
}

async function sendTimed(
	botId: number,
	surface: Surface,
	targetMid: string,
	text: string,
	source: "auto" | "test",
	send: () => Promise<unknown>,
	trace?: FastPathTrace,
	prewarmGuardBotId?: number,
	admissionReserved = false,
): Promise<boolean> {
	// Admission is synchronous and never queues. A message that arrives while
	// the account is cooling down is dropped immediately instead of becoming
	// a stale reply that is sent seconds later.
	const activeTrace = trace ?? {
		botId,
		surface,
		source,
		receivedAt: performance.now(),
		decryptMs: 0,
		matchMs: 0,
		admissionMs: 0,
		protocolPrepMs: 0,
		relayEncodeMs: 0,
		goPrepMs: 0,
		upstreamCalls: 0,
		upstreamMs: 0,
	};
	const admissionStart = performance.now();
	const admissionBotId = prewarmGuardBotId ?? botId;
	const admission = admissionReserved ? { allowed: true, retryAfterMs: 0 } : tryAcquireSend(admissionBotId);
	activeTrace.admissionMs = performance.now() - admissionStart;
	if (!admission.allowed) {
		if (prewarmGuardBotId !== undefined) return false;
		// A reply the bot was supposed to make and did not. Our own limiter
		// is the one silencer that no amount of hardening against the room
		// can help with, and a rival flooding triggers is exactly how it
		// gets provoked — so it belongs in the same log as the rest.
		recordAnomaly({
			botId,
			kind: "send_dropped",
			severity: source === "auto" ? "critical" : "warn",
			chatMid: targetMid,
			detail: `ลิมิตการส่งของเราเองบล็อกข้อความ (${admission.reason}) — ลองใหม่ได้ใน ${Math.ceil(admission.retryAfterMs)}ms`,
		});
		botEvents.emit("send_dropped", {
			botId,
			surface,
			targetMid,
			source,
			reason: admission.reason,
			retryAfterMs: admission.retryAfterMs,
			ts: Date.now(),
		});
		const fastSnapshot = fastPathTracker.record(activeTrace, true, admission.reason);
		botEvents.emit("fast_path", fastSnapshot);
		return false;
	}

	let ok = true;
	try {
		await runWithFastPath(activeTrace, send);
	} catch (err) {
		if (prewarmGuardBotId !== undefined) throw err;
		ok = false;
		emitError(botId, err);
	}
	if (prewarmGuardBotId !== undefined) return ok;
	const fastSnapshot = fastPathTracker.record(activeTrace);
	botEvents.emit("fast_path", fastSnapshot);
	const fastSample = fastSnapshot.last!;
	const preDispatchMs = Math.max(0, (activeTrace.dispatchStartedAt ?? performance.now()) - activeTrace.receivedAt);
	const routingMs = Math.max(
		0,
		preDispatchMs -
			activeTrace.decryptMs -
			activeTrace.matchMs -
			activeTrace.admissionMs -
			activeTrace.protocolPrepMs -
			activeTrace.relayEncodeMs,
	);
	const relayAndParseMs = Math.max(0, fastSample.internalMs - preDispatchMs - activeTrace.goPrepMs);
	// These are the only terms in the displayed equation. CODE is their
	// subtotal, never an extra term beside protocol/Go/transport. Deriving both
	// totals here guarantees the persisted TOTAL equals the visible phase sum.
	const measured = sumLatencyBreakdown({
		lineMs: activeTrace.upstreamMs,
		decryptMs: activeTrace.decryptMs,
		matchMs: activeTrace.matchMs,
		limiterMs: activeTrace.admissionMs,
		routingMs,
		protocolPrepMs: activeTrace.protocolPrepMs,
		relayEncodeMs: activeTrace.relayEncodeMs,
		goPrepMs: activeTrace.goPrepMs,
		relayAndParseMs,
	});
	const latencyMs = measured.totalMs;

	const snapshot = latencyTracker.record({
		botId,
		ts: Date.now(),
		surface,
		targetMid,
		latencyMs,
		ok,
		source,
		textPreview: text.slice(0, 200),
		lineCreatedTime: activeTrace.lineCreatedTime,
		breakdown: {
			lineMs: activeTrace.upstreamMs,
			codeMs: measured.codeMs,
			inboundMs: activeTrace.inboundMs,
			decryptMs: activeTrace.decryptMs,
			matchMs: activeTrace.matchMs,
			limiterMs: activeTrace.admissionMs,
			routingMs,
			protocolPrepMs: activeTrace.protocolPrepMs,
			relayEncodeMs: activeTrace.relayEncodeMs,
			goPrepMs: activeTrace.goPrepMs,
			relayAndParseMs,
			upstreamCalls: activeTrace.upstreamCalls,
		},
	});
	botEvents.emit("send_result", snapshot);
	// Always-visible diagnostic, not gated behind debug logging: the ring
	// buffer this breakdown normally lives in is in-memory only and does not
	// survive a restart, and nothing else prints where a real reply's time
	// actually went. Real auto-replies are rare enough (per-bot cooldown)
	// that this cannot become log spam.
	if (source === "auto") {
		console.log(
			`[bot ${botId}] reply breakdown: total=${latencyMs.toFixed(1)}ms via=${activeTrace.receiveSource ?? "manual"} ` +
				`inbound=${(activeTrace.inboundMs ?? -1).toFixed(1)} decrypt=${activeTrace.decryptMs.toFixed(1)} ` +
				`match=${activeTrace.matchMs.toFixed(1)} limiter=${activeTrace.admissionMs.toFixed(1)} ` +
				`routing=${routingMs.toFixed(1)} protocolPrep=${activeTrace.protocolPrepMs.toFixed(1)} relayEncode=${activeTrace.relayEncodeMs.toFixed(1)} ` +
				`goPrep=${activeTrace.goPrepMs.toFixed(1)} relayAndParse=${relayAndParseMs.toFixed(1)} ` +
				`upstream=${activeTrace.upstreamMs.toFixed(1)} (${activeTrace.upstreamCalls} call(s))`,
		);
	}
	return true;
}

async function refreshChatsCache(botId: number, client: Client): Promise<{ talk: string[]; square: string[] }> {
	const [chats, squareChats] = await Promise.all([client.fetchJoinedChats(), client.fetchJoinedSquareChats()]);
	const now = Date.now();
	for (const chat of chats) {
		upsertChatStmt.run(botId, chat.mid, "talk", chat.name ?? null, now);
	}
	for (const sc of squareChats) {
		upsertChatStmt.run(botId, sc.mid, "square", sc.name ?? null, now);
	}
	botEvents.emit("chats_updated", { botId });

	await Promise.all([
		resolveSquareSelfMids(
			client,
			botId,
			squareChats.map((sc) => sc.mid),
		),
		resolveSquareMemberRoles(
			client,
			botId,
			squareChats.map((sc) => sc.mid),
		),
	]);
	return {
		talk: chats.map((chat) => chat.mid),
		square: squareChats.map((chat) => chat.mid),
	};
}

/**
 * Learns our own member mid in each OpenChat, so recognising our own
 * messages later costs a map read instead of a round trip.
 *
 * Runs after the chat list is already published: it is preparation for
 * the first reply, not something the dashboard should wait on. A chat
 * that fails to resolve is skipped rather than retried — the reply path
 * treats an unknown chat as "not ours", which is the safe direction.
 */
async function resolveSquareSelfMids(client: Client, botId: number, squareChatMids: string[]): Promise<void> {
	await Promise.all(
		squareChatMids.map(async (squareChatMid) => {
			const key = squareSelfMidKey(botId, squareChatMid);
			if (squareSelfMids.has(key)) return;
			try {
				const chat = await client.base.square.getSquareChat({ squareChatMid });
				const selfMid = chat.squareChatMember?.squareMemberMid;
				if (typeof selfMid === "string" && selfMid) {
					squareSelfMids.set(key, selfMid);
				}
			} catch {
				// Leaving it unresolved is survivable; forcing the caller to fail
				// over one OpenChat is not.
			}
		}),
	);
}
