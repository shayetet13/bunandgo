import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./lib/api.ts";
import { useLiveSocket } from "./lib/useWebSocket.ts";
import { playIdLockMismatchAlert } from "./lib/id-lock-alert-audio.ts";
import { reconcileFetchedBots } from "./lib/bot-status-sync.ts";
import { groupBotsByOwner } from "./lib/group-bots.ts";
import { applyVisibleBotOrder } from "./lib/bot-order.ts";
import type {
	Bot,
	BotStatus,
	ChatRow,
	FastPathSnapshot,
	HealthStatus,
	IdLockMismatchEvent,
	LaneRaceSnapshot,
	LatencySample,
	LatencySnapshot,
	LoginPhase,
	MessageIn,
	Rule,
	ScheduledPost,
	UserRole,
} from "./lib/types.ts";
import { Sidebar, type ViewKey } from "./components/Sidebar.tsx";
import { Topbar, type Notification } from "./components/Topbar.tsx";
import { HelpModal } from "./components/HelpModal.tsx";
import { IdLockAlertModal } from "./components/IdLockAlertModal.tsx";
import type { ConfirmState, QrState } from "./components/BotsPanel.tsx";
import type { FeedItem } from "./lib/types.ts";
import { OverviewPage } from "./pages/OverviewPage.tsx";

const BotFleetPage = lazy(async () => ({ default: (await import("./pages/BotFleetPage.tsx")).BotFleetPage }));
const RulesPage = lazy(async () => ({ default: (await import("./pages/RulesPage.tsx")).RulesPage }));
const LiveFeedPage = lazy(async () => ({ default: (await import("./pages/LiveFeedPage.tsx")).LiveFeedPage }));
const SettingsPage = lazy(async () => ({ default: (await import("./pages/SettingsPage.tsx")).SettingsPage }));
const UsersPage = lazy(async () => ({ default: (await import("./pages/UsersPage.tsx")).UsersPage }));
const AnnouncementsPage = lazy(async () => ({ default: (await import("./pages/AnnouncementsPage.tsx")).AnnouncementsPage }));
const ServersPage = lazy(async () => ({ default: (await import("./pages/ServersPage.tsx")).ServersPage }));
const LogsPage = lazy(async () => ({ default: (await import("./pages/LogsPage.tsx")).LogsPage }));

const EMPTY_SNAPSHOT: LatencySnapshot = { p50: 0, p95: 0, p99: 0, okRate: 100, count: 0, windowSize: 500 };
const EMPTY_FAST_SNAPSHOT: FastPathSnapshot = { p50: 0, p95: 0, p99: 0, max: 0, count: 0 };
const EMPTY_LANE_RACE: LaneRaceSnapshot = { retentionDays: 0, lanes: [], daily: [], events: [], latency: [] };
const FEED_CAP = 200;
const DISPATCH_SAMPLE_CAP = 500;
const RATE_WINDOW_MS = 5 * 60_000;
const THROUGHPUT_WINDOW_MS = 60_000;

const PAGE_META: Record<ViewKey, { title: string; subtitle: string }> = {
	overview: { title: "ศูนย์ควบคุม", subtitle: "สถานะสดของบอททุกตัว" },
	fleet: { title: "จัดการบอท", subtitle: "สร้าง เริ่ม หยุด และลบบอท" },
	rules: { title: "กฎการทำงาน", subtitle: "ตั้งเงื่อนไขการตอบอัตโนมัติและทดสอบส่งข้อความ" },
	feed: { title: "บันทึกสด", subtitle: "ข้อความเข้า-ออกแบบเรียลไทม์" },
	settings: { title: "ตั้งค่าระบบ", subtitle: "บัญชีผู้ดูแลและเซสชัน" },
	users: { title: "จัดการผู้ใช้", subtitle: "สร้าง หยุด และลบบัญชีผู้ใช้งาน" },
	announcements: { title: "ข่าวสาร", subtitle: "เพิ่ม แก้ไข และลบประกาศที่จะแสดงในหน้าของผู้ใช้ทุกคน" },
	servers: { title: "เซิร์ฟเวอร์", subtitle: "CPU และ RAM ของทั้ง 3 เซิร์ฟเวอร์แบบสด และย้อนหลัง" },
	logs: { title: "ประวัติ", subtitle: "เหตุการณ์บอท การกระทำผู้ใช้ และความเร็วย้อนหลัง" },
};

interface DashboardProps {
	username: string;
	role: UserRole;
	onLogout: () => void;
}

export function Dashboard({ username, role, onLogout }: DashboardProps) {
	const [activeView, setActiveView] = useState<ViewKey>("overview");
	const [bots, setBots] = useState<Bot[]>([]);
	const [selectedBotId, setSelectedBotId] = useState<number>();
	// Independent from selectedBotId on purpose: bot config (rules, chats,
	// scheduled posts, fleet management) always operates on exactly one bot,
	// but the live feed should show sibling bots of one owner merged into one
	// timeline — see group-bots.ts.
	const [selectedFeedGroupKey, setSelectedFeedGroupKey] = useState<string>();
	const [qrByBot, setQrByBot] = useState<Record<number, QrState>>({});
	const [confirmByBot, setConfirmByBot] = useState<Record<number, ConfirmState>>({});
	const [showHelp, setShowHelp] = useState(false);

	const [chats, setChats] = useState<ChatRow[]>([]);
	const [rules, setRules] = useState<Rule[]>([]);
	const [selectedMids, setSelectedMids] = useState<string[]>([]);
	const [scheduledPosts, setScheduledPosts] = useState<ScheduledPost[]>([]);

	const [snapshot, setSnapshot] = useState<LatencySnapshot>(EMPTY_SNAPSHOT);
	const [fastSnapshot, setFastSnapshot] = useState<FastPathSnapshot>(EMPTY_FAST_SNAPSHOT);
	const [dispatchSamples, setDispatchSamples] = useState<LatencySample[]>([]);
	const [feed, setFeed] = useState<FeedItem[]>([]);
	const [notifications, setNotifications] = useState<Notification[]>([]);
	const [health, setHealth] = useState<HealthStatus>();
	const [laneRace, setLaneRace] = useState<LaneRaceSnapshot>(EMPTY_LANE_RACE);
	const [idLockAlert, setIdLockAlert] = useState<IdLockMismatchEvent>();

	// Rolling logs (timestamps only) for throughput / auto-reply-rate —
	// trimmed to RATE_WINDOW_MS so old activity ages out of the stats.
	const messageInLogRef = useRef<number[]>([]);
	const autoSendLogRef = useRef<number[]>([]);
	const [, forceTick] = useState(0);

	useEffect(() => {
		const timer = setInterval(() => forceTick((n) => n + 1), 5000);
		return () => clearInterval(timer);
	}, []);

	useEffect(() => {
		if (role !== "admin") {
			setHealth(undefined);
			return;
		}
		let cancelled = false;
		function poll() {
			api
				.health()
				.then((h) => {
					if (!cancelled) setHealth(h);
				})
				.catch(() => {
					if (!cancelled) setHealth(undefined);
				});
		}
		poll();
		const timer = setInterval(poll, 5000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [role]);

	// When each bot's status last moved because of a live `bot_status` event —
	// see reconcileFetchedBots for what this protects against.
	const statusEventAtRef = useRef(new Map<number, number>());

	const feedGroups = useMemo(() => groupBotsByOwner(bots), [bots]);
	const feedBotIds = useMemo(() => {
		const group = feedGroups.find((g) => g.key === selectedFeedGroupKey);
		return new Set(group?.bots.map((b) => b.id) ?? []);
	}, [feedGroups, selectedFeedGroupKey]);
	// A stable primitive to depend on in the feed-fetch effect below: `bots`
	// (and so `feedBotIds`, a fresh Set every render) changes on every status
	// flip, which must not re-fetch each sibling's whole feed history — only
	// an actual change in *which* bots belong to the selected group should.
	const feedBotIdsKey = [...feedBotIds].sort((a, b) => a - b).join(",");

	// Mirrors selectedBotId for the stale-response guards below. Those guards
	// run inside a function closure captured at the moment the fetch started —
	// checking the `selectedBotId` state variable directly compares against
	// that same frozen value, not whatever is actually selected by the time
	// the response arrives, so it can never detect a bot switch that happened
	// in between. A ref always reads the current value regardless of which
	// render's closure is asking.
	const selectedBotIdRef = useRef(selectedBotId);
	useEffect(() => {
		selectedBotIdRef.current = selectedBotId;
	}, [selectedBotId]);

	const applyFetchedBots = useCallback((fetched: Bot[], fetchedAt: number) => {
		setBots((prev) => reconcileFetchedBots(prev, fetched, statusEventAtRef.current, fetchedAt));
	}, []);

	const refreshBots = useCallback(async () => {
		const fetchedAt = Date.now();
		applyFetchedBots(await api.listBots().catch(() => []), fetchedAt);
	}, [applyFetchedBots]);
	async function refreshChats(botId: number) {
		const nextChats = await api.listChats(botId).catch(() => []);
		// Guards the same race `refreshRules` already guards against: selecting
		// a different bot before this resolves must not let a slower, stale
		// response overwrite what's now on screen for the newly selected one.
		if (botId === selectedBotIdRef.current) setChats(nextChats);
	}
	async function handleResyncChats(botId: number) {
		try {
			const { chats: nextChats } = await api.resyncChats(botId);
			if (botId === selectedBotIdRef.current) setChats(nextChats);
		} catch (err) {
			pushNotification(err instanceof Error ? err.message : String(err));
		}
	}
	async function handleToggleChatEnabled(chat: ChatRow) {
		try {
			await api.setChatEnabled(chat.bot_id, chat.mid, !chat.enabled);
			setChats((prev) => prev.map((c) => (c.mid === chat.mid ? { ...c, enabled: chat.enabled ? 0 : 1 } : c)));
		} catch (err) {
			pushNotification(err instanceof Error ? err.message : String(err));
		}
	}
	async function handleToggleChatAdminOnly(chat: ChatRow) {
		try {
			await api.setChatAdminOnly(chat.bot_id, chat.mid, !chat.admin_only);
			setChats((prev) => prev.map((c) => (c.mid === chat.mid ? { ...c, admin_only: chat.admin_only ? 0 : 1 } : c)));
		} catch (err) {
			pushNotification(err instanceof Error ? err.message : String(err));
		}
	}
	async function refreshRules(botId: number) {
		const newRules = await api.listRules(botId).catch(() => []);
		if (botId === selectedBotIdRef.current) setRules(newRules);
	}
	async function refreshScheduledPosts(botId: number) {
		const newPosts = await api.listScheduledPosts(botId).catch(() => []);
		if (botId === selectedBotIdRef.current) setScheduledPosts(newPosts);
	}

	function patchBotStatus(botId: number, status: BotStatus) {
		statusEventAtRef.current.set(botId, Date.now());
		setBots((prev) => prev.map((b) => (b.id === botId ? { ...b, status } : b)));
	}

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

	function clearConfirm(botId: number) {
		setConfirmByBot((prev) => {
			if (!(botId in prev)) return prev;
			const next = { ...prev };
			delete next[botId];
			return next;
		});
	}

	const pushNotification = useCallback((message: string) => {
		setNotifications((prev) => [...prev.slice(-19), { id: `${Date.now()}-${Math.random()}`, message, ts: Date.now() }]);
	}, []);

	useEffect(() => {
		void refreshBots();
	}, [refreshBots]);

	useEffect(() => {
		if (selectedBotId === undefined) return;
		refreshChats(selectedBotId);
		refreshRules(selectedBotId);
		refreshScheduledPosts(selectedBotId);
		setSelectedMids([]);
	}, [selectedBotId]);

	useEffect(() => {
		setFeed([]);
		if (feedBotIds.size === 0) return;

		// Replay every bot in the selected group's persisted feed, merged into
		// one timeline. Live WS rows that land while the request is in flight
		// are kept by appending history *behind* them and dropping ids already
		// present, so a message arriving mid-load is neither lost nor shown
		// twice. `cancelled` guards a fast group switch resolving out of order
		// and painting the previous group's history.
		let cancelled = false;
		Promise.all([...feedBotIds].map((botId) => api.botFeed(botId).catch(() => [] as FeedItem[]))).then((results) => {
			if (cancelled) return;
			const history = results.flat().sort((a, b) => a.data.ts - b.data.ts);
			setFeed((live) => {
				const liveIds = new Set(live.map((item) => item.id));
				return [...history.filter((item) => !liveIds.has(item.id)), ...live].slice(-FEED_CAP);
			});
		});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- feedBotIdsKey is the intentional, stable trigger; feedBotIds itself is a fresh Set every render.
	}, [feedBotIdsKey]);

	// Scheduled posts flip from "pending" to "sent"/"missed" on their own
	// clock, not in response to anything the dashboard does — poll so the
	// status shown in the rules page keeps up without a manual refresh.
	useEffect(() => {
		if (selectedBotId === undefined) return;
		const timer = setInterval(() => refreshScheduledPosts(selectedBotId), 15_000);
		return () => clearInterval(timer);
	}, [selectedBotId]);

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
		bot_status: (data) => {
			const { botId, status, phase } = data as { botId: number; status: BotStatus; phase?: LoginPhase };
			patchBotStatus(botId, status);
			if (status === "connecting" && phase) patchLoginPhase(botId, phase);
			if (status !== "connecting") {
				setQrByBot((prev) => {
					if (!(botId in prev)) return prev;
					const next = { ...prev };
					delete next[botId];
					return next;
				});
			}
			// A stored token can let a bot reconnect straight to "connecting"/
			// "online" without ever emitting a fresh `qr` event.
			if (status !== "offline") clearConfirm(botId);
		},
		start_declined: (data) => {
			const { botId } = data as { botId: number };
			clearConfirm(botId);
			pushNotification("ยกเลิกการยืนยันแล้ว — บอทยังไม่เริ่มเชื่อมต่อ");
		},
		id_lock_mismatch: (data) => {
			const event = data as IdLockMismatchEvent;
			clearConfirm(event.botId);
			setIdLockAlert(event);
			playIdLockMismatchAlert(event);
		},
		ready: (data) => {
			const { botId } = data as { botId: number };
			setSelectedBotId(botId);
		},
		message_in: (data) => {
			const msg = data as MessageIn;
			messageInLogRef.current.push(msg.ts);
			messageInLogRef.current = messageInLogRef.current.filter((ts) => Date.now() - ts < RATE_WINDOW_MS);
			if (!feedBotIds.has(msg.botId)) return;
			setFeed((prev) => [...prev.slice(-(FEED_CAP - 1)), { kind: "in", id: `in-${msg.ts}-${Math.random()}`, data: msg }]);
		},
		send_result: (data) => {
			const snap = data as LatencySnapshot;
			setSnapshot(snap);
			if (snap.last) {
				setDispatchSamples((prev) => [...prev.slice(-(DISPATCH_SAMPLE_CAP - 1)), snap.last as LatencySample]);
				if (snap.last.source === "auto") {
					autoSendLogRef.current.push(snap.last.ts);
					autoSendLogRef.current = autoSendLogRef.current.filter((ts) => Date.now() - ts < RATE_WINDOW_MS);
				}
				if (feedBotIds.has(snap.last.botId)) {
					setFeed((prev) => [
						...prev.slice(-(FEED_CAP - 1)),
						{ kind: "out", id: `out-${snap.last!.ts}-${Math.random()}`, data: snap.last as LatencySample },
					]);
				}
			}
		},
		fast_path: (data) => {
			setFastSnapshot(data as FastPathSnapshot);
		},
		bot_error: (data) => {
			const { message } = data as { botId?: number; message: string };
			pushNotification(message);
		},
		chats_updated: (data) => {
			const { botId } = data as { botId: number };
			if (botId === selectedBotId) refreshChats(botId);
		},
	});

	useEffect(() => {
		if (!wsConnected) {
			// Never leave metrics from an old backend process painted as live.
			setSnapshot(EMPTY_SNAPSHOT);
			setFastSnapshot(EMPTY_FAST_SNAPSHOT);
			setDispatchSamples([]);
			setLaneRace(EMPTY_LANE_RACE);
			return;
		}
		let cancelled = false;
		api
			.metricsSnapshot()
			.then((s) => {
				if (!cancelled) setSnapshot(s);
			})
			.catch(() => {
				if (!cancelled) setSnapshot(EMPTY_SNAPSHOT);
			});
		api
			.metricsFastPath()
			.then((metrics) => {
				if (!cancelled) setFastSnapshot(metrics.snapshot);
			})
			.catch(() => {
				if (!cancelled) setFastSnapshot(EMPTY_FAST_SNAPSHOT);
			});
		api
			.metricsHistory(DISPATCH_SAMPLE_CAP)
			.then((rows) => {
				if (!cancelled) setDispatchSamples(rows);
			})
			.catch(() => {
				if (!cancelled) setDispatchSamples([]);
			});
		function refreshLaneRace() {
			api
				.laneRace()
				.then((race) => {
					if (!cancelled) setLaneRace(race);
				})
				.catch(() => {
					if (!cancelled) setLaneRace(EMPTY_LANE_RACE);
				});
		}
		const laneRaceTimer = role === "admin" ? setInterval(refreshLaneRace, 15_000) : undefined;
		if (role === "admin") refreshLaneRace();
		else setLaneRace(EMPTY_LANE_RACE);
		return () => {
			cancelled = true;
			if (laneRaceTimer) clearInterval(laneRaceTimer);
		};
	}, [wsConnected, applyFetchedBots, role]);

	// A dashboard tab's socket can reconnect in the gap between a failed
	// login attempt and its retry (routine — LINE's own servers occasionally
	// answer the QR handshake with a mid-request error). The `qr`/`pincode`
	// events that retry emits only ever fire once, so a tab that missed them
	// is otherwise stuck showing "waiting for QR" with nothing left to scan.
	// Re-checking every bot still "connecting" whenever the socket (re)opens
	// recovers exactly that case — see GET /api/bots/:botId/qr.
	useEffect(() => {
		if (!wsConnected) return;
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

	async function triggerStart(botId: number) {
		const result = await api.startBot(botId);
		if (result.confirmToken && result.confirmUrl) {
			setConfirmByBot((prev) => ({ ...prev, [botId]: { token: result.confirmToken!, url: result.confirmUrl! } }));
		}
	}

	async function handleCreateBot(name: string) {
		try {
			const { rulesCopiedFrom, ...bot } = await api.createBot(name);
			setBots((prev) => [...prev, bot]);
			if (rulesCopiedFrom > 0) pushNotification(`คัดลอกกฎ ${rulesCopiedFrom} ข้อจากบอทพี่น้องให้อัตโนมัติแล้ว`);
			await triggerStart(bot.id);
		} catch (err) {
			pushNotification(err instanceof Error ? err.message : String(err));
		}
	}

	async function handleReorderBots(botIds: number[]): Promise<void> {
		setBots((current) => applyVisibleBotOrder(current, botIds));
		const fetchedAt = Date.now();
		try {
			applyFetchedBots(await api.reorderBots(botIds), fetchedAt);
		} catch (err) {
			await refreshBots();
			pushNotification(err instanceof Error ? err.message : String(err));
			throw err;
		}
	}

	async function handleStart(botId: number) {
		try {
			await triggerStart(botId);
		} catch (err) {
			pushNotification(err instanceof Error ? err.message : String(err));
		}
	}

	async function handleStop(botId: number) {
		try {
			await api.stopBot(botId);
		} catch (err) {
			pushNotification(err instanceof Error ? err.message : String(err));
		}
	}

	async function handleStopAll() {
		const targets = bots.filter((b) => b.status !== "offline");
		await Promise.all(
			targets.map((b) => api.stopBot(b.id).catch((err) => pushNotification(err instanceof Error ? err.message : String(err)))),
		);
	}

	async function handleDeleteBot(botId: number) {
		try {
			await api.deleteBot(botId);
			setBots((prev) => prev.filter((b) => b.id !== botId));
			setQrByBot((prev) => {
				if (!(botId in prev)) return prev;
				const next = { ...prev };
				delete next[botId];
				return next;
			});
			clearConfirm(botId);
			if (selectedBotId === botId) {
				setSelectedBotId(undefined);
				setChats([]);
				setRules([]);
				setFeed([]);
			}
		} catch (err) {
			pushNotification(err instanceof Error ? err.message : String(err));
		}
	}

	async function handleResetIdLock(botId: number) {
		try {
			await api.resetBotIdLock(botId);
			// The backend stops the session as part of this action (see
			// bot-detail.ts) — the WS bot_status event confirms it, but
			// reflecting it here too avoids a stale "online" flash in between.
			setBots((prev) =>
				prev.map((b) => (b.id === botId ? { ...b, status: "offline", lockedLineMid: null, lockedLineDisplayName: null } : b)),
			);
			pushNotification("รีเซ็ตล็อกบัญชี LINE และออกจากระบบ session เดิมแล้ว — กดเริ่มเพื่อสแกน QR บัญชีใหม่ได้เลย");
		} catch (err) {
			pushNotification(err instanceof Error ? err.message : String(err));
		}
	}

	async function handleForceRelogin(botId: number) {
		try {
			await api.forceBotRelogin(botId);
			// Lock stays in place — only the status changes here.
			setBots((prev) => prev.map((b) => (b.id === botId ? { ...b, status: "offline" } : b)));
			pushNotification(
				"ออกจากระบบ session เดิมแล้ว — บัญชี LINE เดิมยังถูกล็อกอยู่ กดเริ่มเพื่อสแกน QR ใหม่ได้เลย (ต้องเป็นบัญชีเดิมเท่านั้น)",
			);
		} catch (err) {
			pushNotification(err instanceof Error ? err.message : String(err));
		}
	}

	async function handleToggleOwnerTesting(bot: Bot) {
		try {
			const updated = await api.updateBotSettings(bot.id, { allowOwnerTesting: !bot.allowOwnerTesting });
			setBots((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
		} catch (err) {
			pushNotification(err instanceof Error ? err.message : String(err));
		}
	}

	async function handleCreateRule(input: Omit<Rule, "id" | "botId">) {
		if (selectedBotId === undefined) return;
		try {
			await api.createRule(selectedBotId, input);
			await refreshRules(selectedBotId);
		} catch (err) {
			pushNotification(err instanceof Error ? err.message : String(err));
		}
	}
	async function handleToggleRule(rule: Rule) {
		try {
			await api.updateRule(rule.botId, rule.id, { ...rule, enabled: !rule.enabled });
			await refreshRules(rule.botId);
		} catch (err) {
			pushNotification(err instanceof Error ? err.message : String(err));
		}
	}
	async function handleUpdateRule(rule: Rule) {
		try {
			await api.updateRule(rule.botId, rule.id, rule);
			await refreshRules(rule.botId);
		} catch (err) {
			pushNotification(err instanceof Error ? err.message : String(err));
		}
	}
	async function handleDeleteRule(id: number) {
		if (selectedBotId === undefined) return;
		try {
			await api.deleteRule(selectedBotId, id);
			await refreshRules(selectedBotId);
		} catch (err) {
			pushNotification(err instanceof Error ? err.message : String(err));
		}
	}

	async function handleCreateScheduledPost(input: Omit<ScheduledPost, "id" | "botId" | "sentAt">) {
		if (selectedBotId === undefined) return;
		try {
			await api.createScheduledPost(selectedBotId, input);
			await refreshScheduledPosts(selectedBotId);
		} catch (err) {
			pushNotification(err instanceof Error ? err.message : String(err));
		}
	}
	async function handleUpdateScheduledPost(post: ScheduledPost) {
		try {
			await api.updateScheduledPost(post.botId, post.id, post);
			await refreshScheduledPosts(post.botId);
		} catch (err) {
			pushNotification(err instanceof Error ? err.message : String(err));
		}
	}
	async function handleToggleScheduledPost(post: ScheduledPost) {
		try {
			await api.updateScheduledPost(post.botId, post.id, { ...post, enabled: !post.enabled });
			await refreshScheduledPosts(post.botId);
		} catch (err) {
			pushNotification(err instanceof Error ? err.message : String(err));
		}
	}
	async function handleDeleteScheduledPost(id: number) {
		if (selectedBotId === undefined) return;
		try {
			await api.deleteScheduledPost(selectedBotId, id);
			await refreshScheduledPosts(selectedBotId);
		} catch (err) {
			pushNotification(err instanceof Error ? err.message : String(err));
		}
	}

	async function handleLogout() {
		await api.logout().catch(() => {});
		onLogout();
	}

	const throughputPerMin = messageInLogRef.current.filter((ts) => Date.now() - ts < THROUGHPUT_WINDOW_MS).length;
	const messagesInWindow = messageInLogRef.current.length;
	const autoRepliesInWindow = autoSendLogRef.current.length;
	const autoReplyRatePercent = messagesInWindow > 0 ? (autoRepliesInWindow / messagesInWindow) * 100 : null;

	const meta = PAGE_META[activeView];

	return (
		<div style={{ display: "flex", height: "100vh", overflow: "hidden" }} className="app-shell dashboard-shell">
			<Sidebar
				activeView={activeView}
				onNavigate={setActiveView}
				wsConnected={wsConnected}
				username={username}
				role={role}
				onLogout={handleLogout}
			/>

			<div
				className="dashboard-content"
				style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}
			>
				<Topbar
					title={meta.title}
					subtitle={meta.subtitle}
					bots={bots}
					health={health}
					notifications={notifications}
					onSelectBot={(bot) => {
						setSelectedBotId(bot.id);
						setActiveView("fleet");
					}}
					onStopAll={handleStopAll}
					onShowHelp={() => setShowHelp(true)}
				/>

				<main
					className="dashboard-main"
					style={{ padding: "var(--space-lg)", flex: 1, overflowY: "auto", width: "100%", boxSizing: "border-box" }}
				>
					<Suspense fallback={<div className="hint">กำลังโหลดหน้า…</div>}>
						{activeView === "overview" && (
							<OverviewPage
								bots={bots}
								snapshot={snapshot}
								fastSnapshot={fastSnapshot}
								throughputPerMin={throughputPerMin}
								autoReplyRatePercent={autoReplyRatePercent}
								historySamples={dispatchSamples}
								laneRace={laneRace}
								health={health}
								wsConnected={wsConnected}
								onCreateBot={() => setActiveView("fleet")}
								onViewFleet={() => setActiveView("fleet")}
							/>
						)}

						{activeView === "fleet" && (
							<BotFleetPage
								bots={bots}
								role={role}
								selectedBotId={selectedBotId}
								onSelect={(bot) => setSelectedBotId(bot.id)}
								qrByBot={qrByBot}
								confirmByBot={confirmByBot}
								onCreateBot={handleCreateBot}
								onStart={handleStart}
								onStop={handleStop}
								onDelete={handleDeleteBot}
								onResetIdLock={handleResetIdLock}
								onForceRelogin={handleForceRelogin}
								onReorder={handleReorderBots}
							/>
						)}

						{activeView === "rules" && (
							<RulesPage
								bots={bots}
								role={role}
								selectedBotId={selectedBotId}
								onSelectBotId={setSelectedBotId}
								onToggleOwnerTesting={handleToggleOwnerTesting}
								rules={rules}
								onCreate={handleCreateRule}
								onToggle={handleToggleRule}
								onUpdate={handleUpdateRule}
								onDelete={handleDeleteRule}
								chats={chats}
								selectedMids={selectedMids}
								onSelectMids={setSelectedMids}
								onToggleChatEnabled={handleToggleChatEnabled}
								onToggleChatAdminOnly={handleToggleChatAdminOnly}
								onResyncChats={handleResyncChats}
								scheduledPosts={scheduledPosts}
								onCreateScheduledPost={handleCreateScheduledPost}
								onUpdateScheduledPost={handleUpdateScheduledPost}
								onToggleScheduledPost={handleToggleScheduledPost}
								onDeleteScheduledPost={handleDeleteScheduledPost}
							/>
						)}

						{activeView === "feed" && (
							<LiveFeedPage
								bots={bots}
								role={role}
								selectedGroupKey={selectedFeedGroupKey}
								onSelectGroupKey={setSelectedFeedGroupKey}
								feed={feed}
							/>
						)}

						{activeView === "users" && role === "admin" && <UsersPage onNotify={pushNotification} />}
						{activeView === "announcements" && role === "admin" && <AnnouncementsPage onNotify={pushNotification} />}
						{activeView === "servers" && role === "admin" && <ServersPage health={health} onNotify={pushNotification} />}
						{activeView === "logs" && role === "admin" && <LogsPage bots={bots} onNotify={pushNotification} />}
						{activeView === "settings" && <SettingsPage username={username} role={role} onLogout={handleLogout} />}
					</Suspense>
				</main>
			</div>

			{showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
			{idLockAlert && <IdLockAlertModal event={idLockAlert} onDismiss={() => setIdLockAlert(undefined)} />}
		</div>
	);
}
