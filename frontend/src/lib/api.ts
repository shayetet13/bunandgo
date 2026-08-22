import type {
	ActiveSessionInfo,
	Anomaly,
	AnomalySummaryRow,
	Bot,
	BotEvent,
	ChatRow,
	FastPathMetrics,
	FeedItem,
	HealthStatus,
	LaneRaceSnapshot,
	LatencySample,
	LatencySnapshot,
	LoginPhase,
	ManagedUser,
	MetricsSummary,
	QuotaPreview,
	RoomBotInfo,
	Rule,
	ScheduledPost,
	SquareMemberInfo,
	Surface,
	UserActionLogEntry,
	UserRole,
} from "./types.ts";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, {
		headers: { "content-type": "application/json" },
		...init,
	});
	if (!res.ok) {
		const body: unknown = await res.json().catch(() => ({}));
		const message = typeof body === "object" && body && "error" in body ? (body as { error?: unknown }).error : undefined;
		throw new Error(typeof message === "string" ? message : `request failed: ${res.status}`);
	}
	return res.json() as Promise<T>;
}

export const api = {
	// Throws with a Thai error message on failure (e.g. wrong password) —
	// callers should try/catch rather than check a returned `ok` flag.
	login: (username: string, password: string) =>
		request<{ ok: true }>("/api/auth/login", {
			method: "POST",
			body: JSON.stringify({ username, password }),
		}),
	logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
	changePassword: (currentPassword: string, newPassword: string) =>
		request<{ ok: true }>("/api/auth/change-password", {
			method: "POST",
			body: JSON.stringify({ currentPassword, newPassword }),
		}),
	me: () =>
		request<{
			authenticated: boolean;
			username: string | null;
			role: UserRole | null;
			botQuota: number | null;
			maxBotQuota: number;
			botPricePerMonthThb: number;
			maintenanceMode: boolean;
		}>("/api/auth/me"),

	listUsers: () => request<ManagedUser[]>("/api/users"),
	createUser: (username: string, password: string) =>
		request<ManagedUser>("/api/users", {
			method: "POST",
			body: JSON.stringify({ username, password }),
		}),
	setUserActive: (userId: number, active: boolean) =>
		request<ManagedUser>(`/api/users/${userId}`, {
			method: "PATCH",
			body: JSON.stringify({ active }),
		}),
	setUserExemptIdLock: (userId: number, exemptIdLock: boolean) =>
		request<ManagedUser>(`/api/users/${userId}`, {
			method: "PATCH",
			body: JSON.stringify({ exemptIdLock }),
		}),
	previewUserBotQuota: (userId: number, quota: number) => request<QuotaPreview>(`/api/users/${userId}/quota-preview?quota=${quota}`),
	setUserBotQuota: (userId: number, botQuota: number) =>
		request<ManagedUser & { stoppedBots: Array<{ id: number; name: string }> }>(`/api/users/${userId}`, {
			method: "PATCH",
			body: JSON.stringify({ botQuota }),
		}),
	deleteUser: (userId: number) => request<{ ok: boolean }>(`/api/users/${userId}`, { method: "DELETE" }),
	// Live logins, most recently active first — see LogsPage's "userActions" tab.
	activeSessions: () => request<ActiveSessionInfo[]>("/api/users/active-sessions"),

	listBots: () => request<Bot[]>("/api/bots"),
	reorderBots: (botIds: number[]) =>
		request<Bot[]>("/api/bots/order", {
			method: "PUT",
			body: JSON.stringify({ botIds }),
		}),
	createBot: (name: string) => request<Bot & { rulesCopiedFrom: number }>("/api/bots", { method: "POST", body: JSON.stringify({ name }) }),
	deleteBot: (botId: number) => request<{ ok: boolean }>(`/api/bots/${botId}`, { method: "DELETE" }),
	updateBotSettings: (botId: number, settings: { allowOwnerTesting: boolean }) =>
		request<Bot>(`/api/bots/${botId}/settings`, {
			method: "PATCH",
			body: JSON.stringify(settings),
		}),
	// Admin-only recovery for a single bot's one-LINE-account lock — e.g. its
	// LINE account was banned and a replacement needs to scan in.
	resetBotIdLock: (botId: number) => request<{ ok: boolean }>(`/api/bots/${botId}/reset-id-lock`, { method: "POST" }),
	// Admin-only: forces a fresh QR on next start without releasing the lock —
	// unlike resetBotIdLock, only the same already-locked LINE account can
	// successfully log back in.
	forceBotRelogin: (botId: number) => request<{ ok: boolean }>(`/api/bots/${botId}/force-relogin`, { method: "POST" }),

	startBot: (botId: number) =>
		request<{ ok: boolean; confirmToken?: string; confirmUrl?: string; message?: string }>(`/api/bots/${botId}/start`, { method: "POST" }),
	stopBot: (botId: number) => request<{ ok: boolean }>(`/api/bots/${botId}/stop`, { method: "POST" }),

	// REST fallback for the `qr`/`pincode` WS events, which only ever fire
	// once — used to recover a QR a client's socket missed while reconnecting
	// mid-handshake. Returns {} if the bot isn't currently "connecting".
	getCurrentQr: (botId: number) => request<{ url?: string; pincode?: string; phase?: LoginPhase }>(`/api/bots/${botId}/qr`),

	// Unauthenticated on purpose — opened by scanning the decoy QR from a
	// device with no dashboard session. See backend/src/api/routes/confirm.ts.
	getStartConfirmation: (token: string) =>
		request<{ status: "pending" | "accepted" | "declined"; botName: string | null }>(`/api/confirm/${token}`),
	acceptStartConfirmation: (token: string) => request<{ ok: boolean }>(`/api/confirm/${token}/accept`, { method: "POST" }),
	declineStartConfirmation: (token: string) => request<{ ok: boolean }>(`/api/confirm/${token}/decline`, { method: "POST" }),

	listChats: (botId: number) => request<ChatRow[]>(`/api/bots/${botId}/chats`),
	setChatEnabled: (botId: number, mid: string, enabled: boolean) =>
		request<{ ok: boolean }>(`/api/bots/${botId}/chats/${mid}`, {
			method: "PATCH",
			body: JSON.stringify({ enabled }),
		}),
	getChatAdminAllowlist: (botId: number, mid: string) =>
		request<{ memberMids: string[]; rolesResolved: boolean }>(`/api/bots/${botId}/chats/${mid}/admin-allowlist`),
	setChatAdminAllowlist: (botId: number, mid: string, memberMids: string[]) =>
		request<{ ok: boolean; memberMids: string[] }>(`/api/bots/${botId}/chats/${mid}/admin-allowlist`, {
			method: "PUT",
			body: JSON.stringify({ memberMids }),
		}),
	setChatAdminOnly: (botId: number, mid: string, adminOnly: boolean) =>
		request<{ ok: boolean }>(`/api/bots/${botId}/chats/${mid}/admin-only`, {
			method: "PATCH",
			body: JSON.stringify({ adminOnly }),
		}),
	// OpenChat-only — 400s if called for a "talk" chat.
	listSquareMembers: (botId: number, mid: string) => request<SquareMemberInfo[]>(`/api/bots/${botId}/chats/${mid}/members`),
	// OpenChat-only: every one of this bot's owner's other bots also sitting
	// in `mid`, including offline ones — see primary-bot.ts.
	listRoomBots: (botId: number, mid: string) => request<RoomBotInfo[]>(`/api/bots/${botId}/chats/${mid}/room-bots`),
	setPrimaryBot: (botId: number, mid: string) => request<{ ok: boolean }>(`/api/bots/${botId}/chats/${mid}/primary`, { method: "PATCH" }),

	listRules: (botId: number) => request<Rule[]>(`/api/bots/${botId}/rules`),
	createRule: (botId: number, input: Omit<Rule, "id" | "botId">) =>
		request<Rule>(`/api/bots/${botId}/rules`, { method: "POST", body: JSON.stringify(input) }),
	updateRule: (botId: number, id: number, input: Omit<Rule, "id" | "botId">) =>
		request<{ ok: boolean }>(`/api/bots/${botId}/rules/${id}`, { method: "PUT", body: JSON.stringify(input) }),
	deleteRule: (botId: number, id: number) => request<{ ok: boolean }>(`/api/bots/${botId}/rules/${id}`, { method: "DELETE" }),

	listScheduledPosts: (botId: number) => request<ScheduledPost[]>(`/api/bots/${botId}/scheduled-posts`),
	createScheduledPost: (botId: number, input: Omit<ScheduledPost, "id" | "botId" | "sentAt">) =>
		request<ScheduledPost>(`/api/bots/${botId}/scheduled-posts`, { method: "POST", body: JSON.stringify(input) }),
	updateScheduledPost: (botId: number, id: number, input: Omit<ScheduledPost, "id" | "botId" | "sentAt">) =>
		request<{ ok: boolean }>(`/api/bots/${botId}/scheduled-posts/${id}`, { method: "PUT", body: JSON.stringify(input) }),
	deleteScheduledPost: (botId: number, id: number) =>
		request<{ ok: boolean }>(`/api/bots/${botId}/scheduled-posts/${id}`, { method: "DELETE" }),

	metricsSnapshot: () => request<LatencySnapshot>("/api/metrics/snapshot"),
	metricsFastPath: (limit = 100) => request<FastPathMetrics>(`/api/metrics/fast-path?limit=${limit}`),
	metricsHistory: (limit = 200, includePreviousRuns = false) =>
		request<LatencySample[]>(`/api/metrics/history?limit=${limit}${includePreviousRuns ? "&scope=all" : ""}`),
	metricsSummary: () => request<MetricsSummary>("/api/metrics/summary"),
	laneRace: () => request<LaneRaceSnapshot>("/api/metrics/lane-race"),
	health: () => request<HealthStatus>("/api/health"),
	restartWorker: () =>
		request<{ ok: true; unit: string; requestedAt: number }>("/api/system/restart-worker", {
			method: "POST",
			body: JSON.stringify({ confirm: "restart-linebot-worker" }),
		}),
	// Admin-only — gates the "user"-role console only; the bot keeps running.
	getMaintenanceMode: () => request<{ enabled: boolean }>("/api/system/maintenance-mode"),
	setMaintenanceMode: (enabled: boolean) =>
		request<{ ok: true; enabled: boolean }>("/api/system/maintenance-mode", {
			method: "PUT",
			body: JSON.stringify({ enabled }),
		}),

	// Logs page (admin only) — `from`/`to` are epoch-ms bounds.
	metricsHistoryRange: (from: number, to: number, limit = 500) =>
		request<LatencySample[]>(`/api/metrics/history?from=${from}&to=${to}&limit=${limit}`),
	botEvents: (botId: number, from: number, to: number, limit = 500) =>
		request<BotEvent[]>(`/api/bots/${botId}/events?from=${from}&to=${to}&limit=${limit}`),

	// Persisted live feed, oldest-first — what the panel shows before (and
	// after) any live WS event arrives, so a refresh or a backend restart no
	// longer empties it.
	botFeed: (botId: number, limit = 200) => request<FeedItem[]>(`/api/bots/${botId}/feed?limit=${limit}`),
	userActionLog: (from: number, to: number, limit = 500) =>
		request<UserActionLogEntry[]>(`/api/logs/user-actions?from=${from}&to=${to}&limit=${limit}`),

	// Interference log: deletions, accepted-but-invisible sends, our own
	// throttle, dead listeners. Newest first.
	anomalies: (params: { botId?: number; kind?: string; severity?: string; since?: number; limit?: number } = {}) => {
		const query = new URLSearchParams();
		if (params.botId !== undefined) query.set("botId", String(params.botId));
		if (params.kind) query.set("kind", params.kind);
		if (params.severity) query.set("severity", params.severity);
		if (params.since !== undefined) query.set("since", String(params.since));
		query.set("limit", String(params.limit ?? 300));
		return request<Anomaly[]>(`/api/logs/anomalies?${query.toString()}`);
	},

	anomalySummary: (botId?: number, windowHours = 24) => {
		const query = new URLSearchParams({ windowHours: String(windowHours) });
		if (botId !== undefined) query.set("botId", String(botId));
		return request<AnomalySummaryRow[]>(`/api/logs/anomalies/summary?${query.toString()}`);
	},

	testSend: (botId: number, surface: Surface, targetMid: string, text: string) =>
		request<{ ok: boolean; error?: string }>(`/api/bots/${botId}/test-send`, {
			method: "POST",
			body: JSON.stringify({ surface, targetMid, text }),
		}),
};
