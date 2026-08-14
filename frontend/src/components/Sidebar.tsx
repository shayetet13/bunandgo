import type { ReactNode } from "react";
import type { UserRole } from "../lib/types.ts";

export type ViewKey = "overview" | "fleet" | "rules" | "feed" | "users" | "logs" | "settings";

interface NavItem {
	key: ViewKey;
	th: string;
	en: string;
	icon: ReactNode;
}

function Icon({ children }: { children: ReactNode }) {
	return (
		<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
			{children}
		</svg>
	);
}

const NAV_ITEMS: NavItem[] = [
	{
		key: "overview",
		th: "ภาพรวม",
		en: "Overview",
		icon: <Icon><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" /></Icon>,
	},
	{
		key: "fleet",
		th: "บอททั้งหมด",
		en: "Bot fleet",
		icon: <Icon><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></Icon>,
	},
	{
		key: "rules",
		th: "กฎการทำงาน",
		en: "Rule builder",
		icon: <Icon><path d="M4 6h16M4 12h10M4 18h13" /></Icon>,
	},
	{
		key: "feed",
		th: "บันทึกสด",
		en: "Live feed",
		icon: <Icon><path d="M3 12h4l2-7 4 14 2-7h6" /></Icon>,
	},
	{
		key: "users",
		th: "ผู้ใช้งาน",
		en: "Users",
		icon: <Icon><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M22 11h-6" /></Icon>,
	},
	{
		key: "logs",
		th: "ประวัติ",
		en: "Logs",
		icon: <Icon><path d="M4 4h16v4H4z" /><path d="M4 10h16M4 16h10" /></Icon>,
	},
	{
		key: "settings",
		th: "ตั้งค่าระบบ",
		en: "Settings",
		icon: <Icon><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.36.4.66.73.85" /></Icon>,
	},
];

interface SidebarProps {
	activeView: ViewKey;
	onNavigate: (view: ViewKey) => void;
	wsConnected: boolean;
	username: string;
	role: UserRole;
	onLogout: () => void;
}

export function Sidebar({ activeView, onNavigate, wsConnected, username, role, onLogout }: SidebarProps) {
	const initials = username ? username.slice(0, 2).toUpperCase() : "?";
	return (
		<aside
			className="app-sidebar"
			style={{
				width: 260,
				flexShrink: 0,
				display: "flex",
				flexDirection: "column",
				borderRight: "1px solid var(--border-hair)",
				background: "var(--bg-base)",
				height: "100%",
				overflowY: "auto",
				padding: "var(--space-md)",
				boxSizing: "border-box",
			}}
		>
			<div className="sidebar-brand" style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)", marginBottom: "var(--space-lg)" }}>
				<div
					style={{
						width: 38,
						height: 38,
						borderRadius: "var(--radius-sm)",
						background: "var(--signal-go)",
						color: "#04170c",
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						fontWeight: 800,
						fontSize: "0.9rem",
						flexShrink: 0,
					}}
				>
					RC
				</div>
				<div>
					<div style={{ fontWeight: 800, letterSpacing: "0.04em", fontSize: "var(--text-sm)" }}>RACE CONSOLE</div>
					<div className="label" style={{ fontSize: "0.6875rem" }}>CONTROL</div>
				</div>
			</div>

			<div className="sidebar-server"
				style={{
					display: "flex",
					alignItems: "center",
					gap: "var(--space-xs)",
					background: "var(--bg-panel)",
					border: "1px solid var(--border-hair)",
					borderRadius: "var(--radius-sm)",
					padding: "0.5rem 0.7rem",
					marginBottom: "var(--space-lg)",
				}}
			>
				<span
					style={{
						width: 7,
						height: 7,
						borderRadius: 999,
						background: wsConnected ? "var(--signal-go)" : "var(--signal-bad)",
						boxShadow: wsConnected ? "0 0 8px var(--signal-go)" : undefined,
						flexShrink: 0,
					}}
				/>
				<div>
					<div style={{ fontSize: "var(--text-xs)", fontWeight: 700 }}>เซิร์ฟเวอร์หลัก</div>
					<div className="hint" style={{ fontSize: "0.6875rem", margin: 0 }}>
						{wsConnected ? "เชื่อมต่ออยู่" : "ขาดการเชื่อมต่อ…"}
					</div>
				</div>
			</div>

			<div className="label sidebar-menu-label" style={{ marginBottom: "var(--space-xs)" }}>เมนู</div>
			<nav className="sidebar-nav" style={{ display: "flex", flexDirection: "column", gap: "0.2rem", flex: 1 }}>
				{NAV_ITEMS.filter((item) => (item.key !== "users" && item.key !== "logs") || role === "admin").map((item) => {
					const active = activeView === item.key;
					return (
						<button
							className="sidebar-nav-button"
							key={item.key}
							onClick={() => onNavigate(item.key)}
							style={{
								display: "flex",
								alignItems: "center",
								gap: "var(--space-sm)",
								textAlign: "left",
								background: active ? "var(--bg-panel-raised)" : "transparent",
								border: `1px solid ${active ? "var(--signal-go-dim)" : "transparent"}`,
								borderRadius: "var(--radius-sm)",
								padding: "0.55rem 0.7rem",
								cursor: "pointer",
								color: active ? "var(--signal-go)" : "var(--text-secondary)",
							}}
						>
							<span style={{ display: "flex", flexShrink: 0 }}>{item.icon}</span>
							<span className="sidebar-nav-copy">
								<div style={{ fontSize: "var(--text-sm)", fontWeight: active ? 700 : 500 }}>{item.th}</div>
								<div style={{ fontSize: "0.6875rem", color: "var(--text-dim)" }}>{item.en}</div>
							</span>
						</button>
					);
				})}
			</nav>

			<div className="sidebar-user" style={{ borderTop: "1px solid var(--border-hair)", paddingTop: "var(--space-sm)", display: "flex", alignItems: "center", gap: "var(--space-sm)" }}>
				<div
					style={{
						width: 32,
						height: 32,
						borderRadius: 999,
						background: "var(--bg-panel-raised)",
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						fontSize: "var(--text-xs)",
						fontWeight: 700,
						flexShrink: 0,
					}}
				>
					{initials}
				</div>
				<div style={{ flex: 1, minWidth: 0 }}>
					<div style={{ fontSize: "var(--text-sm)", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{username || "—"}</div>
					<div className="hint" style={{ fontSize: "0.6875rem", margin: 0 }}>{role === "admin" ? "ผู้ดูแลระบบ" : "ผู้ใช้งาน"}</div>
				</div>
				<button
					onClick={onLogout}
					title="ออกจากระบบ"
					style={{ background: "transparent", border: "1px solid var(--border-strong)", color: "var(--text-secondary)", borderRadius: "var(--radius-sm)", padding: "0.35rem 0.5rem", cursor: "pointer", fontSize: "var(--text-xs)" }}
				>
					⏻
				</button>
			</div>
		</aside>
	);
}
