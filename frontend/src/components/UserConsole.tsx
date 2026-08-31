import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import type {
	Announcement,
	Bot,
	BotStatus,
	ChatRow,
	IdLockMismatchEvent,
	LatencySample,
	LatencySnapshot,
	LoginPhase,
	Rule,
	ScheduledPost,
} from "../lib/types.ts";
import { useLiveSocket } from "../lib/useWebSocket.ts";
import { playAlertSiren } from "../lib/siren.ts";
import { playIdLockMismatchAlert } from "../lib/id-lock-alert-audio.ts";
import { reconcileFetchedBots } from "../lib/bot-status-sync.ts";
import { previewReplyText } from "../lib/text-preview.ts";
import { bangkokInputToEpochMs, formatBangkokDateTime } from "../lib/bangkok-time.ts";
import { parseSecondsAndMs, secondsSuffix } from "../lib/seconds-input.ts";
import {
	isScheduledPostRunAtValid,
	isScheduledPostToggleable,
	SCHEDULED_POST_STATUS_LABEL,
	scheduledPostStatusOf,
} from "../lib/scheduled-post-status.ts";
import { RULE_MATCH_GUIDES, ruleMatchFeedback, validateRuleMatchValue } from "../lib/rule-input.ts";
import type { QrState } from "./BotsPanel.tsx";
import { QrPanel } from "./QrPanel.tsx";
import { StartConfirmPanel } from "./StartConfirmPanel.tsx";
import { ToggleSwitch } from "./ToggleSwitch.tsx";
import { AdminOnlyControl } from "./AdminOnlyControl.tsx";
import { IdLockAlertModal } from "./IdLockAlertModal.tsx";
import { AnnouncementAlertModal } from "./AnnouncementAlertModal.tsx";
import { dismissAnnouncementModalAlert, undismissedModalAlerts } from "../lib/announcement-alert-dismissal.ts";
import { CHAT_CATEGORY_FILTERS, chatCategory, chatLabel, type ChatCategoryFilter } from "../lib/chat-category.ts";
import { newestScheduledPostsFirst } from "../lib/scheduled-post-order.ts";

interface ConfirmState {
	token: string;
	url: string;
}

interface UserConsoleProps {
	username: string;
	onLogout: () => void;
}

const MAX_LOGS = 150;

// Until /api/auth/me answers, assume the starting allowance rather than
// zero — a flash of "you are out of bots" on every page load would be worse
// than a create button that the server rejects in the rare mismatch.
const DEFAULT_BOT_QUOTA = 1;

const MATCH_TYPE_LABEL: Record<Rule["matchType"], string> = {
	equals: "ตรงทั้งหมด",
	startsWith: "ขึ้นต้นด้วย",
	containsAny: "มีคำนี้ในข้อความ",
	regex: "regex (ขั้นสูง)",
};

/**
 * The three things a user configures. Split into tabs rather than stacked into
 * one scroll: each is a separate job, and on a phone the old single column put
 * the log — the thing people actually watch — five screens below the fold.
 */
type TabId = "rooms" | "keywords" | "schedule";

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
	{ id: "rooms", label: "ห้องแชท" },
	{ id: "keywords", label: "คีย์เวิร์ด" },
	{ id: "schedule", label: "ตั้งเวลาโพส" },
];

function timeLabel(timestamp: number): string {
	return new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(timestamp);
}

function announceTimeLabel(timestamp: number): string {
	return new Intl.DateTimeFormat("th-TH", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function surfaceLabel(surface: LatencySample["surface"]): string {
	return surface === "square" ? "OP Talk" : surface === "oa" ? "LINE OA" : "LINE Talk";
}

function statusLabel(status: BotStatus): string {
	if (status === "online") return "ออนไลน์";
	if (status === "connecting") return "กำลังเชื่อมต่อ";
	return "ออฟไลน์";
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function UserConsole({ username, onLogout }: UserConsoleProps) {
	const [bots, setBots] = useState<Bot[]>([]);
	const [logs, setLogs] = useState<LatencySample[]>([]);
	const [selectedBotId, setSelectedBotId] = useState<number>();
	const [loading, setLoading] = useState(true);
	const [qrByBot, setQrByBot] = useState<Record<number, QrState>>({});
	const [confirmByBot, setConfirmByBot] = useState<Record<number, ConfirmState>>({});
	const [errorMessage, setErrorMessage] = useState<string>();
	const [idLockAlert, setIdLockAlert] = useState<IdLockMismatchEvent>();
	const [announcements, setAnnouncements] = useState<Announcement[]>([]);
	const [modalAlertsClosed, setModalAlertsClosed] = useState(false);

	const [tab, setTab] = useState<TabId>("rooms");

	const [showCreateBotForm, setShowCreateBotForm] = useState(false);
	const [newBotName, setNewBotName] = useState("");
	const [botQuota, setBotQuota] = useState(DEFAULT_BOT_QUOTA);
	const [botPrice, setBotPrice] = useState(100);

	const [chats, setChats] = useState<ChatRow[]>([]);
	const [groupQuery, setGroupQuery] = useState("");
	const [roomCategory, setRoomCategory] = useState<ChatCategoryFilter>("all");

	const [rules, setRules] = useState<Rule[]>([]);
	const [showRuleForm, setShowRuleForm] = useState(false);
	const [ruleMatchType, setRuleMatchType] = useState<Rule["matchType"]>("containsAny");
	const [ruleMatchValue, setRuleMatchValue] = useState("");
	const [ruleReplyText, setRuleReplyText] = useState("");
	const [ruleError, setRuleError] = useState<string>();
	const ruleFeedback = ruleMatchFeedback(ruleMatchType, ruleMatchValue);
	const displayedRuleError = ruleFeedback?.valid === false ? ruleFeedback.message : ruleError;

	const [scheduledPosts, setScheduledPosts] = useState<ScheduledPost[]>([]);
	const [showSpForm, setShowSpForm] = useState(false);
	const [spTargetMid, setSpTargetMid] = useState("");
	const [spText, setSpText] = useState("");
	// Native mobile datetime-local pickers commonly stop at minute
	// granularity in their touch UI — Chrome/Safari's own text-style
	// seconds/ms segments (which `step="0.001"` unlocks on desktop) don't
	// exist there. The sub-minute part therefore gets its own field so exact
	// timing is reachable on a phone, not just a desktop browser — see admin's
	// ScheduledPostEditor for the desktop equivalent. One `ss.mmm` field
	// rather than two counters: see lib/seconds-input.ts.
	const [spDateTimeInput, setSpDateTimeInput] = useState("");
	const [spSecondsInput, setSpSecondsInput] = useState("");
	const [spError, setSpError] = useState<string>();

	const pushError = useCallback((err: unknown) => {
		setErrorMessage(errorText(err));
	}, []);

	// When each bot's status last moved because of a live `bot_status` event —
	// see reconcileFetchedBots for what this protects against.
	const statusEventAtRef = useRef(new Map<number, number>());

	// Mirrors selectedBotId for the stale-response guards below — a closure
	// captured when a fetch started compares against the `selectedBotId` value
	// frozen at that moment, not whatever is actually selected once the
	// response arrives, so it can never detect a bot switch in between. A ref
	// always reads the current value regardless of which render's closure
	// is asking.
	const selectedBotIdRef = useRef(selectedBotId);
	useEffect(() => {
		selectedBotIdRef.current = selectedBotId;
	}, [selectedBotId]);

	const applyFetchedBots = useCallback((fetched: Bot[], fetchedAt: number) => {
		setBots((prev) => reconcileFetchedBots(prev, fetched, statusEventAtRef.current, fetchedAt));
	}, []);

	function patchLoginPhase(botId: number, phase: LoginPhase) {
		setQrByBot((prev) => {
			const current = prev[botId];
			if (current?.phase === phase) return prev;
			// Only "awaiting_scan" has a live code. Every other phase means the
			// one we may be holding is spent or superseded, so a tab showing it
			// has to stop offering it.
			return { ...prev, [botId]: phase === "awaiting_scan" ? { ...current, phase } : { phase } };
		});
	}

	const refresh = useCallback(async () => {
		setLoading(true);
		const fetchedAt = Date.now();
		try {
			const [nextBots, nextLogs] = await Promise.all([api.listBots(), api.metricsHistory(MAX_LOGS, true)]);
			applyFetchedBots(nextBots, fetchedAt);
			setLogs(nextLogs.slice(-MAX_LOGS).reverse());
		} catch (err) {
			// Every other fetch failure in this file surfaces via pushError; this
			// one previously had no catch at all, so a rejection here (network
			// blip, an expired session) cleared the loading spinner as if it had
			// succeeded and left the user looking at silently stale data.
			pushError(err);
		} finally {
			setLoading(false);
		}
	}, [applyFetchedBots, pushError]);

	async function refreshChats(botId: number) {
		// A genuine fetch failure must surface via pushError like every other
		// one in this file, not render as "this bot has no chats".
		let nextChats: ChatRow[];
		try {
			nextChats = await api.listChats(botId);
		} catch (err) {
			pushError(err);
			return;
		}
		// Guards the same race `refreshRules` already guards against: selecting
		// a different bot before this resolves must not let a slower, stale
		// response overwrite what's now on screen for the newly selected one.
		if (botId === selectedBotIdRef.current) setChats(nextChats);
	}

	async function refreshRules(botId: number) {
		let nextRules: Rule[];
		try {
			nextRules = await api.listRules(botId);
		} catch (err) {
			pushError(err);
			return;
		}
		if (botId === selectedBotIdRef.current) setRules(nextRules);
	}

	async function refreshScheduledPosts(botId: number) {
		let nextPosts: ScheduledPost[];
		try {
			nextPosts = await api.listScheduledPosts(botId);
		} catch (err) {
			pushError(err);
			return;
		}
		if (botId === selectedBotIdRef.current) setScheduledPosts(newestScheduledPostsFirst(nextPosts));
	}

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// The quota and the price live on the server so raising either does not
	// need a frontend deploy.
	useEffect(() => {
		void api
			.me()
			.then((me) => {
				if (me.botQuota !== null) setBotQuota(me.botQuota);
				setBotPrice(me.botPricePerMonthThb);
			})
			.catch(() => {
				// Keep the defaults; the create call itself is the real gate.
			});
	}, []);

	// Admin-authored notices — fetched once. They change only when an admin
	// edits them from the dashboard, never as a side effect of anything on
	// this console, so there is nothing here worth polling for.
	useEffect(() => {
		void api
			.listAnnouncements()
			.then((fetched) => {
				setAnnouncements(fetched);
				// Once per page load, and only when there is something to alert
				// about — an empty announcement list should stay quiet.
				if (fetched.length > 0) playAlertSiren();
			})
			.catch(() => {
				// A failed fetch just leaves the card empty rather than blocking
				// the rest of the console over a non-essential notice list.
			});
	}, []);

	const modalAlerts = useMemo(
		() => (modalAlertsClosed ? [] : undismissedModalAlerts(announcements)),
		[announcements, modalAlertsClosed],
	);
	function handleDismissModalAlerts() {
		for (const item of modalAlerts) dismissAnnouncementModalAlert(item.id);
		setModalAlertsClosed(true);
	}

	useEffect(() => {
		setGroupQuery("");
		if (selectedBotId === undefined) {
			setChats([]);
			setRules([]);
			setScheduledPosts([]);
			return;
		}
		void refreshChats(selectedBotId);
		void refreshRules(selectedBotId);
		void refreshScheduledPosts(selectedBotId);
	}, [selectedBotId]);

	// Scheduled posts flip from "pending" to "sent"/"missed" on the clock, not
	// in response to anything the console does — poll while a bot is selected
	// so the status shown here keeps up without a manual refresh.
	useEffect(() => {
		if (selectedBotId === undefined) return;
		const timer = setInterval(() => void refreshScheduledPosts(selectedBotId), 15_000);
		return () => clearInterval(timer);
	}, [selectedBotId]);

	// Keeps the target picker pointed at a chat that still exists, defaulting
	// to the first one whenever the current selection is stale (bot switched,
	// chats just loaded, or the previously picked chat disappeared).
	useEffect(() => {
		if (chats.length === 0) {
			setSpTargetMid("");
			return;
		}
		if (!chats.some((c) => c.mid === spTargetMid)) setSpTargetMid(chats[0]!.mid);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [chats]);

	function clearConfirm(botId: number) {
		setConfirmByBot((prev) => {
			if (!(botId in prev)) return prev;
			const next = { ...prev };
			delete next[botId];
			return next;
		});
	}

	const wsConnected = useLiveSocket({
		qr: (data) => {
			const { botId, url } = data as { botId: number; url: string };
			setQrByBot((prev) => ({ ...prev, [botId]: { ...prev[botId], url, phase: "awaiting_scan" } }));
			clearConfirm(botId);
		},
		pincode: (data) => {
			const { botId, pin } = data as { botId: number; pin: string };
			setQrByBot((prev) => ({ ...prev, [botId]: { ...prev[botId], pincode: pin, phase: "awaiting_scan" } }));
		},
		ready: (data) => {
			const { botId } = data as { botId: number };
			setSelectedBotId(botId);
		},
		send_result: (data) => {
			const sample = (data as LatencySnapshot).last;
			if (!sample) return;
			setLogs((previous) =>
				[sample, ...previous.filter((item) => item.ts !== sample.ts || item.botId !== sample.botId)].slice(0, MAX_LOGS),
			);
		},
		bot_status: (data) => {
			const event = data as { botId: number; status: BotStatus; phase?: LoginPhase };
			statusEventAtRef.current.set(event.botId, Date.now());
			setBots((previous) => previous.map((bot) => (bot.id === event.botId ? { ...bot, status: event.status } : bot)));
			if (event.status === "connecting" && event.phase) patchLoginPhase(event.botId, event.phase);
			if (event.status !== "connecting") {
				setQrByBot((prev) => {
					if (!(event.botId in prev)) return prev;
					const next = { ...prev };
					delete next[event.botId];
					return next;
				});
			}
			// A stored token can let a bot reconnect straight to "connecting"/
			// "online" without ever emitting a fresh `qr` event — clear the
			// decoy here too so it doesn't linger over a silent reconnect.
			if (event.status !== "offline") clearConfirm(event.botId);
		},
		start_declined: (data) => {
			const { botId } = data as { botId: number };
			clearConfirm(botId);
			setErrorMessage('ยกเลิกการยืนยันแล้ว — บอทยังไม่เริ่มเชื่อมต่อ กด "เริ่ม" ใหม่ได้เมื่อพร้อม');
		},
		id_lock_mismatch: (data) => {
			const event = data as IdLockMismatchEvent;
			clearConfirm(event.botId);
			setIdLockAlert(event);
			playIdLockMismatchAlert(event);
		},
		chats_updated: (data) => {
			const { botId } = data as { botId: number };
			if (botId === selectedBotId) void refreshChats(botId);
		},
	});

	// A tab's socket can reconnect in the gap between a failed login attempt
	// and its retry (routine — LINE's own servers occasionally answer the QR
	// handshake with a mid-request error). The `qr`/`pincode` events that
	// retry emits only ever fire once, so a tab that missed them is otherwise
	// stuck showing "waiting for QR" with nothing left to scan. Re-checking
	// every bot still "connecting" whenever the socket (re)opens recovers
	// exactly that case — see GET /api/bots/:botId/qr.
	useEffect(() => {
		if (!wsConnected) return;
		// Guards the same race Dashboard.tsx's identical effect already guards
		// against: on a flaky connection, two reconnects in quick succession
		// dispatch two overlapping listBots()/getCurrentQr() calls, and
		// without this an older one resolving after a newer one can silently
		// overwrite current state with a stale snapshot (missing a bot just
		// created, or resurrecting one just deleted).
		let cancelled = false;
		const fetchedAt = Date.now();
		api
			.listBots()
			.then((freshBots) => {
				if (cancelled) return;
				applyFetchedBots(freshBots, fetchedAt);
				for (const bot of freshBots) {
					if (bot.status !== "connecting") continue;
					api
						.getCurrentQr(bot.id)
						.then((qr) => {
							if (cancelled) return;
							if (qr.phase) patchLoginPhase(bot.id, qr.phase);
							if (!qr.url && !qr.pincode) return;
							setQrByBot((prev) => ({ ...prev, [bot.id]: { url: qr.url, pincode: qr.pincode, phase: qr.phase } }));
						})
						.catch(() => {});
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [wsConnected, applyFetchedBots]);

	const enabledMids = useMemo(() => chats.filter((chat) => !!chat.enabled).map((chat) => chat.mid), [chats]);

	const visibleLogs = useMemo(() => {
		let result = selectedBotId === undefined ? logs : logs.filter((log) => log.botId === selectedBotId);
		if (enabledMids.length > 0) {
			result = result.filter((log) => log.targetMid !== null && enabledMids.includes(log.targetMid));
		}
		return result;
	}, [logs, selectedBotId, enabledMids]);
	const botNames = useMemo(() => new Map(bots.map((bot) => [bot.id, bot.name])), [bots]);
	const latest = visibleLogs[0];
	const selectedBot = bots.find((bot) => bot.id === selectedBotId);
	const pendingConfirm = selectedBotId !== undefined ? confirmByBot[selectedBotId] : undefined;
	const canCreateBot = bots.length < botQuota;

	const normalizedGroupQuery = groupQuery.trim().toLowerCase();
	const visibleChats = chats.filter(
		(chat) =>
			(roomCategory === "all" || chatCategory(chat) === roomCategory) &&
			(!normalizedGroupQuery ||
				(chat.name ?? "").toLowerCase().includes(normalizedGroupQuery) ||
				chat.mid.toLowerCase().includes(normalizedGroupQuery)),
	);
	const roomCategoryCounts = Object.fromEntries(
		CHAT_CATEGORY_FILTERS.map(({ id }) => [id, id === "all" ? chats.length : chats.filter((chat) => chatCategory(chat) === id).length]),
	) as Record<ChatCategoryFilter, number>;

	async function logout() {
		await api.logout().catch(() => {});
		onLogout();
	}

	async function triggerStart(botId: number) {
		const result = await api.startBot(botId);
		if (result.confirmToken && result.confirmUrl) {
			setConfirmByBot((prev) => ({ ...prev, [botId]: { token: result.confirmToken!, url: result.confirmUrl! } }));
		}
	}

	async function submitCreateBot(e: FormEvent) {
		e.preventDefault();
		if (!newBotName.trim()) return;
		try {
			const bot = await api.createBot(newBotName.trim());
			setBots((prev) => [...prev, bot]);
			setNewBotName("");
			setShowCreateBotForm(false);
			setSelectedBotId(bot.id);
			await triggerStart(bot.id);
		} catch (err) {
			pushError(err);
		}
	}

	async function handleStart(botId: number) {
		try {
			await triggerStart(botId);
		} catch (err) {
			pushError(err);
		}
	}

	async function handleStop(botId: number) {
		try {
			await api.stopBot(botId);
		} catch (err) {
			pushError(err);
		}
	}

	async function toggleGroupEnabled(chat: ChatRow) {
		const nextEnabled = !chat.enabled;
		try {
			await api.setChatEnabled(chat.bot_id, chat.mid, nextEnabled);
			setChats((prev) => prev.map((c) => (c.mid === chat.mid ? { ...c, enabled: nextEnabled ? 1 : 0 } : c)));
		} catch (err) {
			pushError(err);
		}
	}

	async function toggleGroupAdminOnly(chat: ChatRow) {
		const nextAdminOnly = !chat.admin_only;
		try {
			await api.setChatAdminOnly(chat.bot_id, chat.mid, nextAdminOnly);
			setChats((prev) => prev.map((c) => (c.mid === chat.mid ? { ...c, admin_only: nextAdminOnly ? 1 : 0 } : c)));
		} catch (err) {
			pushError(err);
		}
	}

	async function submitCreateRule(e: FormEvent) {
		e.preventDefault();
		if (selectedBotId === undefined) return;
		const keyError = validateRuleMatchValue(ruleMatchType, ruleMatchValue);
		if (keyError) {
			setRuleError(keyError);
			return;
		}
		if (!ruleReplyText.trim()) {
			setRuleError("กรุณากรอกข้อความที่ต้องการให้บอทตอบกลับ");
			return;
		}
		setRuleError(undefined);
		try {
			await api.createRule(selectedBotId, {
				surface: "all",
				matchType: ruleMatchType,
				matchValue: ruleMatchValue.trim(),
				replyText: ruleReplyText.trim(),
				enabled: true,
				priority: 0,
			});
			setRuleMatchValue("");
			setRuleReplyText("");
			await refreshRules(selectedBotId);
		} catch (err) {
			setRuleError(errorText(err));
		}
	}

	async function handleToggleRule(rule: Rule) {
		try {
			await api.updateRule(rule.botId, rule.id, { ...rule, enabled: !rule.enabled });
			await refreshRules(rule.botId);
		} catch (err) {
			pushError(err);
		}
	}

	async function handleDeleteRule(rule: Rule) {
		try {
			await api.deleteRule(rule.botId, rule.id);
			await refreshRules(rule.botId);
		} catch (err) {
			pushError(err);
		}
	}

	/** Combines the minute-precision picker with the `ss.mmm` field into one `bangkokInputToEpochMs`-ready string. */
	function spPreciseInput(): string | undefined {
		if (!spDateTimeInput) return undefined;
		const parsed = parseSecondsAndMs(spSecondsInput);
		if (!parsed) return undefined;
		return `${spDateTimeInput}${secondsSuffix(parsed)}`;
	}

	async function submitCreateScheduledPost(e: FormEvent) {
		e.preventDefault();
		if (selectedBotId === undefined) return;
		setSpError(undefined);
		const chat = chats.find((c) => c.mid === spTargetMid);
		// A bad seconds field is its own mistake, and saying so beats the
		// generic "fill everything in" for a field that looks filled in.
		if (spDateTimeInput && parseSecondsAndMs(spSecondsInput) === undefined) {
			setSpError("วินาทีไม่ถูกต้อง — ใช้รูปแบบ วินาที.มิลลิวินาที เช่น 5.250 (0 ถึง 59.999)");
			return;
		}
		const preciseInput = spPreciseInput();
		const runAt = preciseInput === undefined ? undefined : bangkokInputToEpochMs(preciseInput);
		if (!chat || runAt === undefined || !spText.trim()) {
			setSpError("กรอกห้องแชท ข้อความ และวันเวลาให้ครบ");
			return;
		}
		if (!isScheduledPostRunAtValid(runAt)) {
			setSpError("เวลาที่ตั้งต้องอยู่ในอนาคต");
			return;
		}
		try {
			await api.createScheduledPost(selectedBotId, { surface: chat.surface, targetMid: chat.mid, text: spText, runAt, enabled: true });
			setSpText("");
			setSpDateTimeInput("");
			setSpSecondsInput("");
			await refreshScheduledPosts(selectedBotId);
		} catch (err) {
			pushError(err);
		}
	}

	async function handleToggleScheduledPost(post: ScheduledPost) {
		try {
			await api.updateScheduledPost(post.botId, post.id, { ...post, enabled: !post.enabled });
			await refreshScheduledPosts(post.botId);
		} catch (err) {
			pushError(err);
		}
	}

	async function handleDeleteScheduledPost(post: ScheduledPost) {
		try {
			await api.deleteScheduledPost(post.botId, post.id);
			await refreshScheduledPosts(post.botId);
		} catch (err) {
			pushError(err);
		}
	}

	const speedTone = latest === undefined ? "idle" : latest.ok ? "ok" : "bad";
	const speedLabel = latest === undefined ? "ยังไม่มีข้อมูล" : latest.ok ? "ส่งสำเร็จ" : "ส่งไม่สำเร็จ";
	const tabCount: Record<TabId, number> = {
		rooms: enabledMids.length,
		keywords: rules.length,
		schedule: scheduledPosts.length,
	};

	return (
		<div className="uc">
			<div className="uc-shell">
				<header className="uc-header">
					<div className="uc-identity">
						<span className="uc-live" data-state={wsConnected ? "on" : "off"}>
							<i className="uc-live-dot" aria-hidden="true" />
							{wsConnected ? "LIVE" : "OFFLINE"}
						</span>
						<span className="uc-username">{username}</span>
					</div>
					<button className="uc-logout" onClick={() => void logout()}>
						ออกจากระบบ
					</button>
				</header>

				{errorMessage && (
					<div className="uc-error" role="alert">
						<span>{errorMessage}</span>
						<button onClick={() => setErrorMessage(undefined)} aria-label="ปิดข้อความแจ้งเตือน">
							✕
						</button>
					</div>
				)}

				<div className="uc-body">
					<aside className="uc-rail">
						<section className="uc-speed">
							<span className="uc-eyebrow">Latency</span>
							<div className="uc-speed-value">
								{latest ? Math.round(latest.latencyMs) : "—"}
								{latest && <span className="uc-speed-unit">ms</span>}
							</div>
							<span className="uc-speed-badge" data-tone={speedTone}>
								{speedLabel}
							</span>
						</section>

						<section className="uc-announce" data-has-content={announcements.length > 0} aria-live="polite">
							<div className="uc-announce-head">
								<span className="uc-eyebrow">ประกาศ</span>
								{announcements.length > 0 && (
									<span className="uc-announce-badge">
										<span className="uc-announce-badge-icon" aria-hidden="true">
											🚨
										</span>
										ประกาศจากแอดมิน
									</span>
								)}
							</div>
							{announcements.length === 0 ? (
								<p className="uc-announce-empty">ยังไม่มีประกาศจากแอดมิน</p>
							) : (
								<div className="uc-announce-list">
									{announcements.map((item) => (
										<article className="uc-announce-item" key={item.id} data-pinned={item.isPinned}>
											<strong className="uc-announce-title">
												{item.isPinned && (
													<span aria-label="ปักหมุดอยู่" title="ปักหมุดอยู่">
														📌{" "}
													</span>
												)}
												{item.title}
											</strong>
											<p className="uc-announce-body">{item.body}</p>
											<span className="uc-announce-time">{announceTimeLabel(item.updatedAt)}</span>
										</article>
									))}
								</div>
							)}
						</section>

						<section className="uc-card">
							<div className="uc-card-head">
								<span className="uc-card-title">บอทของฉัน</span>
								{canCreateBot && (
									<button className="uc-btn uc-btn--sm uc-btn--ghost" onClick={() => setShowCreateBotForm((s) => !s)}>
										{showCreateBotForm ? "ยกเลิก" : "+ เพิ่มบอท"}
									</button>
								)}
							</div>
							<div className="uc-card-body">
								{canCreateBot && showCreateBotForm && (
									<form className="uc-form" onSubmit={submitCreateBot}>
										<div className="uc-field">
											<label className="uc-field-label" htmlFor="uc-new-bot">
												ชื่อบอท
											</label>
											<input
												autoFocus
												id="uc-new-bot"
												className="uc-input"
												placeholder="เช่น กลุ่มหวย 1"
												value={newBotName}
												onChange={(e) => setNewBotName(e.target.value)}
											/>
										</div>
										<button type="submit" className="uc-btn uc-btn--primary uc-btn--block">
											สร้าง &amp; เข้าสู่ระบบ
										</button>
									</form>
								)}

								<div className="uc-bot-list">
									<button className="uc-bot" aria-pressed={selectedBotId === undefined} onClick={() => setSelectedBotId(undefined)}>
										<i className="uc-bot-dot" aria-hidden="true" />
										<span className="uc-bot-name">ทั้งหมด</span>
										<span className="uc-bot-state">{bots.length} บอท</span>
									</button>
									{bots.map((bot) => (
										<button
											key={bot.id}
											className="uc-bot"
											aria-pressed={selectedBotId === bot.id}
											onClick={() => setSelectedBotId(bot.id)}
										>
											<i className="uc-bot-dot" data-state={bot.status} aria-hidden="true" />
											<span className="uc-bot-name">{bot.name}</span>
											{/* Otherwise pressing "เริ่ม" on a locked bot just fails with
											    an error and no explanation of what to do about it. */}
											<span className="uc-bot-state">{bot.overQuota ? "🔒 เกินโควตา" : statusLabel(bot.status)}</span>
										</button>
									))}
								</div>

								{!canCreateBot && (
									<div className="uc-note">
										<strong>
											ใช้บอทครบโควตาแล้ว ({bots.length}/{botQuota} ตัว)
										</strong>
										<p style={{ margin: "0.35rem 0 0" }}>
											ติดต่อผู้ดูแลระบบเพื่อปลดล็อกเพิ่ม — ค่าบริการ {botPrice} บาท/เดือน ต่อบอท 1 ตัว
										</p>
										<p style={{ margin: "0.35rem 0 0" }}>
											ยิ่งมีบอทหลายตัวยิ่งมีโอกาสชนะสูงขึ้น: แต่ละตัวมีจังหวะการตรวจข้อความของตัวเอง ตัวที่เห็นคิวก่อนจะเป็นคนตอบ
											และบอทของคุณจะไม่ตอบซ้ำกันเองในห้องเดียวกัน
										</p>
									</div>
								)}
								{canCreateBot && bots.length > 0 && (
									<p className="uc-note">
										ใช้ไป {bots.length}/{botQuota} ตัว — เพิ่มได้อีก {botQuota - bots.length} ตัว
									</p>
								)}

								{selectedBot && (
									<div className="uc-run-bar">
										<span className="uc-run-label">
											{selectedBot.name} · {statusLabel(selectedBot.status)}
										</span>
										{selectedBot.overQuota ? (
											// Shown instead of a start button rather than a start
											// button that fails: the fix is a payment, not a retry.
											<span className="uc-run-label" style={{ color: "var(--uc-ink-3)" }}>
												🔒 เกินโควตา — ติดต่อผู้ดูแลระบบเพื่อเปิดใช้ ({botPrice} บาท/เดือน ต่อบอท 1 ตัว)
											</span>
										) : selectedBot.status === "offline" ? (
											pendingConfirm ? (
												<button className="uc-btn uc-btn--sm uc-btn--ghost" disabled>
													รอการยืนยัน…
												</button>
											) : (
												<button className="uc-btn uc-btn--sm uc-btn--primary" onClick={() => void handleStart(selectedBot.id)}>
													เริ่ม
												</button>
											)
										) : (
											<button className="uc-btn uc-btn--sm uc-btn--stop" onClick={() => void handleStop(selectedBot.id)}>
												หยุด
											</button>
										)}
									</div>
								)}
							</div>
						</section>

						{selectedBot?.status === "offline" && pendingConfirm && (
							<StartConfirmPanel botName={selectedBot.name} confirmUrl={pendingConfirm.url} />
						)}

						{selectedBot?.status === "connecting" && (
							<QrPanel
								botName={selectedBot.name}
								qrUrl={qrByBot[selectedBot.id]?.url}
								pincode={qrByBot[selectedBot.id]?.pincode}
								phase={qrByBot[selectedBot.id]?.phase}
								onCancel={() => void handleStop(selectedBot.id)}
							/>
						)}
					</aside>

					<div className="uc-main">
						{selectedBotId === undefined ? (
							<section className="uc-card">
								<p className="uc-empty">
									{bots.length === 0
										? 'ยังไม่มีบอท — กด "เพิ่มบอท" เพื่อเริ่มต้น'
										: "เลือกบอทจากรายการเพื่อตั้งค่าห้องแชท คีย์เวิร์ด และการโพสตามเวลา"}
								</p>
							</section>
						) : (
							<>
								<div className="uc-tabs" role="tablist" aria-label="ตั้งค่าบอท">
									{TABS.map((item) => (
										<button
											key={item.id}
											id={`uc-tab-${item.id}`}
											role="tab"
											className="uc-tab"
											aria-selected={tab === item.id}
											aria-controls={`uc-panel-${item.id}`}
											onClick={() => setTab(item.id)}
										>
											{item.label}
											<span className="uc-tab-count">{tabCount[item.id]}</span>
										</button>
									))}
								</div>

								{tab === "rooms" && (
									<div className="uc-panel" role="tabpanel" id="uc-panel-rooms" aria-labelledby="uc-tab-rooms">
										<section className="uc-card">
											<div className="uc-card-head">
												<span className="uc-card-title">ห้องที่เปิดให้บอทตอบ</span>
												<span className="uc-eyebrow">
													{enabledMids.length}/{chats.length}
												</span>
											</div>
											<div className="uc-card-body">
												<p className="uc-note">
													บอทจะตอบเฉพาะห้องที่เปิดสวิตช์ไว้ — แชท 1:1 บุคคลทั่วไปจะไม่ตอบกลับ ส่วน LINE OA, OP Talk และกลุ่ม LINE
													จะแยกประเภทให้ชัดเจนด้านล่าง
												</p>
												<div className="uc-search">
													<span aria-hidden="true">⌕</span>
													<input
														value={groupQuery}
														onChange={(e) => setGroupQuery(e.target.value)}
														placeholder="ค้นหา 1:1, LINE OA, OP Talk หรือกลุ่ม…"
														aria-label="ค้นหาห้องแชท"
													/>
												</div>
												<div className="uc-room-tabs" role="tablist" aria-label="ประเภทห้องแชท">
													{CHAT_CATEGORY_FILTERS.map((item) => (
														<button
															key={item.id}
															className="uc-room-tab"
															role="tab"
															aria-selected={roomCategory === item.id}
															onClick={() => setRoomCategory(item.id)}
														>
															<span>{item.label}</span>
															<span className="uc-room-tab-count">{roomCategoryCounts[item.id]}</span>
														</button>
													))}
												</div>
												<div className="uc-rows">
													{visibleChats.length === 0 && (
														<p className="uc-empty">{chats.length === 0 ? "ยังไม่มีข้อมูลห้องแชท" : "ไม่พบห้องที่ค้นหา"}</p>
													)}
													{visibleChats.map((chat) => (
														<div
															className={chat.surface === "square" ? "uc-row uc-chat-row uc-chat-row--openchat" : "uc-row uc-chat-row"}
															key={chat.mid}
														>
															<span className="uc-tag">{chatLabel(chat)}</span>
															<div className="uc-row-main">
																<span className="uc-row-title">{chat.name ?? chat.mid}</span>
															</div>
															{/* Keep the OpenChat-only control in its own grid column. Putting it
													    under the name makes the title sit above the row's visual centre. */}
															{chat.surface === "square" && selectedBotId !== undefined && (
																<div className="uc-chat-row-admin">
																	<AdminOnlyControl
																		botId={selectedBotId}
																		chat={chat}
																		onToggleAdminOnly={(target) => void toggleGroupAdminOnly(target)}
																		onError={setErrorMessage}
																	/>
																</div>
															)}
															<div className="uc-row-actions">
																<ToggleSwitch isSelected={!!chat.enabled} onToggle={() => void toggleGroupEnabled(chat)} />
															</div>
														</div>
													))}
												</div>
											</div>
										</section>
									</div>
								)}

								{tab === "keywords" && (
									<div className="uc-panel" role="tabpanel" id="uc-panel-keywords" aria-labelledby="uc-tab-keywords">
										<section className="uc-card">
											<div className="uc-card-head">
												<span className="uc-card-title">คีย์เวิร์ดตอบอัตโนมัติ</span>
												<button className="uc-btn uc-btn--sm uc-btn--ghost" onClick={() => setShowRuleForm((s) => !s)}>
													{showRuleForm ? "ยกเลิก" : "+ เพิ่ม"}
												</button>
											</div>
											<div className="uc-card-body">
												{showRuleForm && (
													<form className="uc-form uc-form--split" onSubmit={submitCreateRule}>
														<div className="uc-field">
															<label className="uc-field-label" htmlFor="uc-rule-type">
																เงื่อนไข
															</label>
															<select
																id="uc-rule-type"
																className="uc-select"
																value={ruleMatchType}
																onChange={(e) => {
																	setRuleMatchType(e.target.value as Rule["matchType"]);
																	setRuleError(undefined);
																}}
															>
																{(Object.keys(MATCH_TYPE_LABEL) as Rule["matchType"][]).map((type) => (
																	<option key={type} value={type}>
																		{MATCH_TYPE_LABEL[type]}
																	</option>
																))}
															</select>
														</div>
														<div className="uc-field">
															<label className="uc-field-label" htmlFor="uc-rule-value">
																คำที่ให้จับ
															</label>
															<input
																id="uc-rule-value"
																className="uc-input"
																placeholder={RULE_MATCH_GUIDES[ruleMatchType].placeholder}
																value={ruleMatchValue}
																onChange={(e) => {
																	setRuleMatchValue(e.target.value);
																	setRuleError(undefined);
																}}
																aria-invalid={displayedRuleError ? true : undefined}
																aria-describedby="uc-rule-key-help uc-rule-error"
															/>
															<p className="uc-note" id="uc-rule-key-help">
																{RULE_MATCH_GUIDES[ruleMatchType].help}
															</p>
														</div>
														<div className="uc-field uc-field--wide">
															<label className="uc-field-label" htmlFor="uc-rule-reply">
																ข้อความตอบกลับ
															</label>
															<textarea
																id="uc-rule-reply"
																className="uc-textarea"
																placeholder="พิมพ์ข้อความที่บอทจะตอบ"
																value={ruleReplyText}
																onChange={(e) => {
																	setRuleReplyText(e.target.value);
																	setRuleError(undefined);
																}}
																rows={3}
															/>
														</div>
														{displayedRuleError && (
															<p className="uc-form-error" id="uc-rule-error" role="alert">
																{displayedRuleError}
															</p>
														)}
														{!displayedRuleError && ruleFeedback?.valid && (
															<p className="uc-form-success" role="status">
																{ruleFeedback.message}
															</p>
														)}
														<button type="submit" className="uc-btn uc-btn--primary uc-btn--block">
															เพิ่มคีย์เวิร์ด
														</button>
													</form>
												)}

												{rules.length === 0 && !showRuleForm ? (
													<div className="uc-empty">
														ยังไม่มีคีย์เวิร์ด — เพิ่มเพื่อให้บอทตอบข้อความอัตโนมัติ
														<div className="uc-empty-action">
															<button className="uc-btn uc-btn--sm uc-btn--primary" onClick={() => setShowRuleForm(true)}>
																+ เพิ่มคีย์เวิร์ดแรก
															</button>
														</div>
													</div>
												) : (
													<div className="uc-rows">
														{rules.map((rule) => (
															<div className={`uc-row ${rule.enabled ? "" : "uc-row--off"}`} key={rule.id}>
																<div className="uc-row-main">
																	<span className="uc-row-title">{rule.matchValue}</span>
																	<span className="uc-row-sub">→ {previewReplyText(rule.replyText)}</span>
																</div>
																<div className="uc-row-actions">
																	<ToggleSwitch isSelected={rule.enabled} onToggle={() => void handleToggleRule(rule)} />
																	<button
																		className="uc-icon-btn"
																		onClick={() => void handleDeleteRule(rule)}
																		aria-label={`ลบคีย์เวิร์ด ${rule.matchValue}`}
																	>
																		✕
																	</button>
																</div>
															</div>
														))}
													</div>
												)}
											</div>
										</section>
									</div>
								)}

								{tab === "schedule" && (
									<div className="uc-panel" role="tabpanel" id="uc-panel-schedule" aria-labelledby="uc-tab-schedule">
										<section className="uc-card">
											<div className="uc-card-head">
												<span className="uc-card-title">โพสตามเวลา</span>
												<button className="uc-btn uc-btn--sm uc-btn--ghost" onClick={() => setShowSpForm((s) => !s)}>
													{showSpForm ? "ยกเลิก" : "+ เพิ่ม"}
												</button>
											</div>
											<div className="uc-card-body">
												<p className="uc-note">
													ไม่ต้องใช้คีย์เวิร์ด — ตั้งวันเวลา (เวลาไทย ละเอียดถึงมิลลิวินาที) ไว้ล่วงหน้า
													พอถึงเวลาบอทจะโพสข้อความที่เตรียมไว้ทันที
												</p>

												{showSpForm && (
													<form className="uc-form uc-form--split" onSubmit={submitCreateScheduledPost}>
														{spError && <p className="uc-form-error">{spError}</p>}
														<div className="uc-field uc-field--wide">
															<label className="uc-field-label" htmlFor="uc-sp-room">
																ห้องแชท
															</label>
															<select
																id="uc-sp-room"
																className="uc-select"
																value={spTargetMid}
																onChange={(e) => setSpTargetMid(e.target.value)}
															>
																<option value="" disabled>
																	— เลือกห้องแชท —
																</option>
																{chats.map((chat) => (
																	<option key={chat.mid} value={chat.mid}>
																		{chatLabel(chat)} · {chat.name ?? chat.mid}
																	</option>
																))}
															</select>
														</div>
														<div className="uc-field">
															<label className="uc-field-label" htmlFor="uc-sp-datetime">
																วันและเวลา
															</label>
															<input
																type="datetime-local"
																id="uc-sp-datetime"
																className="uc-input"
																value={spDateTimeInput}
																onChange={(e) => setSpDateTimeInput(e.target.value)}
															/>
														</div>
														<div className="uc-field">
															<label className="uc-field-label" htmlFor="uc-sp-sec">
																วินาที <span className="uc-field-hint">— ไม่ใส่ = ต้นนาที</span>
															</label>
															<input
																type="text"
																inputMode="decimal"
																id="uc-sp-sec"
																className="uc-input"
																placeholder="เช่น 5.250"
																value={spSecondsInput}
																onChange={(e) => setSpSecondsInput(e.target.value)}
																aria-describedby="uc-sp-sec-help"
															/>
														</div>
														<p className="uc-note uc-field--wide" id="uc-sp-sec-help">
															ปฏิทินเลือกได้ละเอียดสุดแค่<strong>นาที</strong> ถ้าอยากให้เป๊ะกว่านั้นใส่วินาทีเพิ่มในช่องขวา —{" "}
															<code className="uc-code">5.250</code> คือ 5 วินาที 250 มิลลิวินาที, <code className="uc-code">5</code> คือ 5
															วินาทีตรง
														</p>
														<div className="uc-field uc-field--wide">
															<label className="uc-field-label" htmlFor="uc-sp-text">
																ข้อความที่จะโพส
															</label>
															<textarea
																id="uc-sp-text"
																className="uc-textarea"
																placeholder="พิมพ์ข้อความที่จะโพสเมื่อถึงเวลา"
																value={spText}
																onChange={(e) => setSpText(e.target.value)}
																rows={3}
															/>
														</div>
														<button type="submit" className="uc-btn uc-btn--primary uc-btn--block">
															ตั้งเวลาโพส
														</button>
													</form>
												)}

												{scheduledPosts.length === 0 && !showSpForm ? (
													<div className="uc-empty">
														ยังไม่มีรายการโพสตามเวลา
														<div className="uc-empty-action">
															<button className="uc-btn uc-btn--sm uc-btn--primary" onClick={() => setShowSpForm(true)}>
																+ ตั้งเวลาโพสแรก
															</button>
														</div>
													</div>
												) : (
													<div className="uc-rows">
														{scheduledPosts.map((post) => {
															const status = scheduledPostStatusOf(post);
															const chat = chats.find((c) => c.mid === post.targetMid);
															const settled = status === "sent" || status === "missed";
															return (
																<div className={`uc-row uc-row--stack ${settled ? "uc-row--off" : ""}`} key={post.id}>
																	<div className="uc-sched-head">
																		<span className="uc-sched-time">{formatBangkokDateTime(post.runAt)}</span>
																		<span className={`uc-badge uc-badge--${status}`}>{SCHEDULED_POST_STATUS_LABEL[status]}</span>
																	</div>
																	<div className="uc-row-main">
																		<span className="uc-row-sub">
																			{chat ? chatLabel(chat) : surfaceLabel(post.surface)} · {chat?.name ?? post.targetMid}
																		</span>
																		<span className="uc-row-title">{previewReplyText(post.text)}</span>
																	</div>
																	<div className="uc-row-actions uc-row-actions--end">
																		{isScheduledPostToggleable(status) && (
																			<ToggleSwitch isSelected={post.enabled} onToggle={() => void handleToggleScheduledPost(post)} />
																		)}
																		<button
																			className="uc-icon-btn"
																			onClick={() => void handleDeleteScheduledPost(post)}
																			aria-label="ลบรายการโพสตามเวลา"
																		>
																			✕
																		</button>
																	</div>
																</div>
															);
														})}
													</div>
												)}
											</div>
										</section>
									</div>
								)}
							</>
						)}
					</div>
				</div>

				<section className="uc-card">
					<div className="uc-card-head">
						<span className="uc-card-title">บันทึกการส่ง</span>
						<div className="uc-row-actions">
							<span className="uc-eyebrow">{visibleLogs.length} รายการ</span>
							<button className="uc-btn uc-btn--sm uc-btn--ghost" onClick={() => void refresh()} disabled={loading}>
								{loading ? "กำลังโหลด…" : "รีเฟรช"}
							</button>
						</div>
					</div>
					<div className="uc-log-body">
						{!loading && visibleLogs.length === 0 && <p className="uc-empty">พร้อมรับข้อมูล — ข้อความที่บอทส่งจะแสดงที่นี่อัตโนมัติ</p>}
						{visibleLogs.map((log) => (
							<div className="uc-log-line" data-ok={log.ok} key={`${log.botId}-${log.ts}`}>
								<span className="uc-log-ts">{timeLabel(log.ts)}</span>
								<span className="uc-log-tag">{surfaceLabel(log.surface)}</span>
								<span className="uc-log-bot">{botNames.get(log.botId) ?? `Bot ${log.botId}`}</span>
								<span className="uc-log-arrow">»</span>
								<span className="uc-log-text">{log.textPreview || "(ไม่มีข้อความตัวอย่าง)"}</span>
								<span className="uc-log-src">{log.source === "auto" ? "ตอบอัตโนมัติ" : "ส่งทดสอบ"}</span>
								<span className="uc-log-ms">{Math.round(log.latencyMs)}ms</span>
							</div>
						))}
					</div>
				</section>
			</div>
			{idLockAlert && <IdLockAlertModal event={idLockAlert} onDismiss={() => setIdLockAlert(undefined)} />}
			{modalAlerts.length > 0 && <AnnouncementAlertModal announcements={modalAlerts} onDismiss={handleDismissModalAlerts} />}
		</div>
	);
}
