import { useState } from "react";
import type { Bot, HealthStatus, ServerStatus } from "../lib/types.ts";
import { summarizeServer, type ServerTone } from "../lib/server-status.ts";
import { botMatchesSearch } from "../lib/bot-search.ts";

export interface Notification {
	id: string;
	message: string;
	ts: number;
}

interface TopbarProps {
	title: string;
	subtitle: string;
	bots: Bot[];
	health?: HealthStatus;
	notifications: Notification[];
	onSelectBot: (bot: Bot) => void;
	onStopAll: () => void;
	onShowHelp: () => void;
}

function timeAgo(ts: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
	if (seconds < 60) return `${seconds} วิที่แล้ว`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} นาทีที่แล้ว`;
	return `${Math.floor(minutes / 60)} ชม.ที่แล้ว`;
}

const SERVER_STATUS_COLORS: Record<ServerTone, string> = {
	go: "var(--signal-go)",
	warn: "var(--signal-warn)",
	bad: "var(--signal-bad)",
	idle: "var(--signal-idle)",
};

function ServerChip({ server }: { server?: ServerStatus }) {
	const summary = summarizeServer(server);
	const color = SERVER_STATUS_COLORS[summary.tone];
	return (
		<span
			className="chip"
			style={{ color, borderColor: color, whiteSpace: "nowrap" }}
			title={`${server?.role ?? "สถานะเซิร์ฟเวอร์"}\n${summary.detail}`}
		>
			<span className="chip-dot" />
			<span style={{ fontWeight: 800 }}>{server?.label ?? "Server"}</span>
			<span style={{ color: "var(--text-secondary)" }}>·</span>
			{summary.label}
		</span>
	);
}

export function Topbar({ title, subtitle, bots, health, notifications, onSelectBot, onStopAll, onShowHelp }: TopbarProps) {
	const [query, setQuery] = useState("");
	const [searchFocused, setSearchFocused] = useState(false);
	const [showNotifications, setShowNotifications] = useState(false);
	const [confirmStop, setConfirmStop] = useState(false);

	const matches = query.trim() ? bots.filter((bot) => botMatchesSearch(bot, query)).slice(0, 8) : [];

	const activeBots = bots.filter((b) => b.status !== "offline");
	// `servers` is optional-chained separately from `health`: a backend older
	// than this field answers /api/health with a perfectly valid object that
	// simply has no `servers` array, and `health?.servers.find(...)` throws on
	// it — taking the whole dashboard down over a chip. Frontend and backend
	// are deployed to different machines here, so that skew is a normal state,
	// not a bug: both chips fall back to "unknown" until the API catches up.
	const server1 = health?.servers?.find((server) => server.id === "server1");
	const server2 = health?.servers?.find((server) => server.id === "server2");
	const connectorTone: ServerTone = [server1, server2].some((server) => summarizeServer(server).tone === "bad")
		? "bad"
		: [server1, server2].some((server) => summarizeServer(server).tone === "warn")
			? "warn"
			: server1 && server2
				? "go"
				: "idle";
	const connectorColor = SERVER_STATUS_COLORS[connectorTone];

	return (
		<header
			className="app-topbar"
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: "var(--space-md)",
				padding: "var(--space-md) var(--space-lg)",
				borderBottom: "1px solid var(--border-hair)",
				flexWrap: "wrap",
			}}
		>
			<div>
				<div className="label">{subtitle}</div>
				<h1 style={{ margin: 0, fontSize: "1.3rem", fontWeight: 800 }}>{title}</h1>
			</div>

			<div className="topbar-actions" style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)", position: "relative" }}>
				<div className="topbar-search" style={{ position: "relative" }}>
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onFocus={() => setSearchFocused(true)}
						onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
						placeholder="ค้นหาชื่อ, Bot ID หรือชื่อ LINE..."
						aria-label="ค้นหาบอทด้วยชื่อที่ลงทะเบียน Bot ID หรือชื่อบัญชี LINE"
						style={{
							width: 240,
							background: "var(--bg-inset)",
							border: "1px solid var(--border-hair)",
							borderRadius: "var(--radius-sm)",
							padding: "0.5rem 0.75rem",
							color: "var(--text-primary)",
							fontSize: "var(--text-sm)",
						}}
					/>
					{searchFocused && matches.length > 0 && (
						<div
							className="panel"
							style={{
								position: "absolute",
								top: "110%",
								left: 0,
								right: 0,
								zIndex: 20,
								padding: "var(--space-xs)",
								background: "var(--bg-panel-raised)",
							}}
						>
							{matches.map((bot) => (
								<button
									key={bot.id}
									onMouseDown={() => onSelectBot(bot)}
									style={{
										display: "block",
										width: "100%",
										textAlign: "left",
										background: "transparent",
										border: "none",
										color: "var(--text-primary)",
										padding: "0.4rem 0.5rem",
										borderRadius: "var(--radius-sm)",
										cursor: "pointer",
										fontSize: "var(--text-sm)",
									}}
								>
									<div style={{ fontWeight: 700 }}>
										bot{bot.slot} · {bot.name}
									</div>
									<div className="hint" style={{ margin: 0, fontSize: "0.6875rem" }}>
										ID #{bot.id}
										{bot.lockedLineDisplayName ? ` · LINE: ${bot.lockedLineDisplayName}` : ""}
									</div>
								</button>
							))}
						</div>
					)}
				</div>

				<div style={{ position: "relative" }}>
					<button
						onClick={() => setShowNotifications((s) => !s)}
						style={{
							position: "relative",
							background: "var(--bg-inset)",
							border: "1px solid var(--border-hair)",
							borderRadius: "var(--radius-sm)",
							padding: "0.5rem 0.6rem",
							color: "var(--text-secondary)",
							cursor: "pointer",
						}}
					>
						🔔
						{notifications.length > 0 && (
							<span
								style={{
									position: "absolute",
									top: -4,
									right: -4,
									background: "var(--signal-bad)",
									color: "#fff",
									borderRadius: 999,
									fontSize: "0.625rem",
									minWidth: 16,
									height: 16,
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
									padding: "0 3px",
								}}
							>
								{notifications.length > 9 ? "9+" : notifications.length}
							</span>
						)}
					</button>
					{showNotifications && (
						<div
							className="panel"
							style={{
								position: "absolute",
								top: "110%",
								right: 0,
								width: 300,
								zIndex: 20,
								padding: "var(--space-sm)",
								background: "var(--bg-panel-raised)",
							}}
						>
							<div className="label" style={{ marginBottom: "var(--space-xs)" }}>
								แจ้งเตือนล่าสุด
							</div>
							{notifications.length === 0 ? (
								<p className="hint" style={{ margin: 0 }}>
									ไม่มีแจ้งเตือน
								</p>
							) : (
								<div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", maxHeight: 260, overflowY: "auto" }}>
									{[...notifications].reverse().map((n) => (
										<div
											key={n.id}
											style={{ fontSize: "var(--text-sm)", borderBottom: "1px solid var(--border-hair)", paddingBottom: "0.4rem" }}
										>
											<div>{n.message}</div>
											<div className="hint" style={{ fontSize: "0.6875rem", margin: 0 }}>
												{timeAgo(n.ts)}
											</div>
										</div>
									))}
								</div>
							)}
						</div>
					)}
				</div>

				{health?.servers && (
					<div
						style={{ display: "flex", alignItems: "center", gap: "0.35rem", flexWrap: "wrap", justifyContent: "center" }}
						aria-label="สถานะการเชื่อมต่อระหว่าง Server 1 และ Server 2"
					>
						<ServerChip server={server1} />
						<span
							title="การเชื่อมต่อส่วนตัวระหว่างสองเซิร์ฟเวอร์"
							style={{ color: connectorColor, fontSize: "1.1rem", fontWeight: 900, lineHeight: 1 }}
						>
							⟷
						</span>
						<ServerChip server={server2} />
					</div>
				)}

				<button
					onClick={onShowHelp}
					title="วิธีใช้งาน"
					style={{
						background: "var(--bg-inset)",
						border: "1px solid var(--border-hair)",
						borderRadius: "var(--radius-sm)",
						padding: "0.5rem 0.7rem",
						color: "var(--text-secondary)",
						cursor: "pointer",
						fontWeight: 700,
					}}
				>
					?
				</button>

				{confirmStop ? (
					<div style={{ display: "flex", gap: "0.4rem" }}>
						<button
							onClick={() => {
								onStopAll();
								setConfirmStop(false);
							}}
							style={{
								background: "var(--signal-bad)",
								color: "#fff",
								border: "none",
								borderRadius: "var(--radius-sm)",
								padding: "0.5rem 0.9rem",
								fontWeight: 700,
								cursor: "pointer",
							}}
						>
							ยืนยันหยุดทั้งหมด
						</button>
						<button
							onClick={() => setConfirmStop(false)}
							style={{
								background: "transparent",
								border: "1px solid var(--border-strong)",
								color: "var(--text-secondary)",
								borderRadius: "var(--radius-sm)",
								padding: "0.5rem 0.9rem",
								cursor: "pointer",
							}}
						>
							ยกเลิก
						</button>
					</div>
				) : (
					<button
						onClick={() => setConfirmStop(true)}
						disabled={activeBots.length === 0}
						title="หยุดทุกบอทที่กำลังทำงาน"
						style={{
							background: "var(--signal-bad)",
							color: "#fff",
							border: "none",
							borderRadius: "var(--radius-sm)",
							padding: "0.5rem 1rem",
							fontWeight: 800,
							letterSpacing: "0.05em",
							cursor: activeBots.length === 0 ? "default" : "pointer",
							opacity: activeBots.length === 0 ? 0.4 : 1,
						}}
					>
						STOP
					</button>
				)}
			</div>
		</header>
	);
}
