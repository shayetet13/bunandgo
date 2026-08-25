import { useEffect, useState } from "react";
import type { ChatRow, SquareMemberInfo } from "../lib/types.ts";
import { api } from "../lib/api.ts";
import { ToggleSwitch } from "./ToggleSwitch.tsx";
import { AdminOnlyControl } from "./AdminOnlyControl.tsx";
import { RoomBotsPanel } from "./RoomBotsPanel.tsx";

interface ChatListProps {
	botId: number;
	chats: ChatRow[];
	selectedMids?: string[];
	onSelect: (mids: string[]) => void;
	onToggleEnabled: (chat: ChatRow) => void;
	onToggleAdminOnly: (chat: ChatRow) => void;
	/** Re-syncs from the bot's live LINE session right now — mainly for an OA friend added while the bot was already running. */
	onResync: (botId: number) => Promise<void> | void;
	/**
	 * Whether this bot's owner has other bots at all — gates the room-bots
	 * panel below so a solo owner (the common case) never even renders a
	 * button for a feature that would only ever say "just you".
	 */
	hasSiblings?: boolean;
}

function isAdminRole(role: SquareMemberInfo["role"]): boolean {
	return role === "ADMIN" || role === 1 || role === "CO_ADMIN" || role === 2;
}

export function ChatList({
	botId,
	chats,
	selectedMids = [],
	onSelect,
	onToggleEnabled,
	onToggleAdminOnly,
	onResync,
	hasSiblings = false,
}: ChatListProps) {
	const [query, setQuery] = useState("");
	const [surface, setSurface] = useState<"all" | "talk" | "oa" | "square">("all");
	const [adminsByMid, setAdminsByMid] = useState<Record<string, SquareMemberInfo[]>>({});
	const [resyncing, setResyncing] = useState(false);

	// OpenChat-only: fetch each visible OP's cached ADMIN/CO_ADMIN roles once,
	// so the badge can show who the switch below would actually answer to.
	// Fire-and-forget — a room with no resolved admins yet (bot just
	// connected) simply shows none, and re-opening the page retries.
	useEffect(() => {
		const squareMids = chats.filter((chat) => chat.surface === "square").map((chat) => chat.mid);
		for (const mid of squareMids) {
			if (mid in adminsByMid) continue;
			api
				.listSquareMembers(botId, mid)
				.then((members) => {
					setAdminsByMid((prev) => ({ ...prev, [mid]: members.filter((m) => isAdminRole(m.role)) }));
				})
				.catch(() => {
					setAdminsByMid((prev) => ({ ...prev, [mid]: [] }));
				});
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [botId, chats]);
	const normalizedQuery = query.trim().toLowerCase();
	const visibleChats = chats.filter(
		(chat) =>
			(surface === "all" || chat.surface === surface) &&
			(!normalizedQuery || (chat.name ?? "").toLowerCase().includes(normalizedQuery) || chat.mid.toLowerCase().includes(normalizedQuery)),
	);
	const handleToggle = (mid: string) => {
		const newSelection = selectedMids.includes(mid) ? selectedMids.filter((m) => m !== mid) : [...selectedMids, mid];
		onSelect(newSelection);
	};
	const handleResyncClick = async () => {
		setResyncing(true);
		try {
			await onResync(botId);
		} finally {
			setResyncing(false);
		}
	};

	return (
		<section className="panel" style={{ padding: "var(--space-md)" }}>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: "var(--space-sm)",
					marginBottom: "var(--space-xs)",
				}}
			>
				<div className="label">ห้องแชทที่เข้าร่วม · {chats.length}</div>
				<button
					onClick={handleResyncClick}
					disabled={resyncing}
					className="ghost-button"
					style={{ fontSize: "var(--text-xs)", padding: "0.4rem 0.75rem", minHeight: "auto", opacity: resyncing ? 0.6 : 1 }}
				>
					{resyncing ? "กำลังซิงค์…" : "⟳ ซิงค์รายชื่อแชท/OA ตอนนี้"}
				</button>
			</div>
			<p className="hint" style={{ margin: "0 0 var(--space-sm)" }}>
				สลับ "ตอบอัตโนมัติ" เพื่อกำหนดว่าบอทจะตอบข้อความจริงในห้องไหนได้บ้าง (ปิดอยู่ = ไม่ตอบเลย) —
				คลิกที่การ์ดเพื่อเลือกห้องสำหรับกรอกข้อมูลในช่องทดสอบส่งข้อความด้านล่าง เพิ่งเพิ่มเพื่อน OA ใหม่แล้วยังไม่เห็น? กด "ซิงค์"
				ด้านบนได้เลย ไม่ต้องรอบอท restart
			</p>
			<div className="chat-search-row">
				<div className="chat-search-box">
					<span aria-hidden="true">⌕</span>
					<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ค้นหาชื่อกลุ่มหรือ OP..." />
				</div>
				<div className="chat-filter-tabs">
					{(["all", "talk", "oa", "square"] as const).map((value) => (
						<button key={value} className={surface === value ? "active" : ""} onClick={() => setSurface(value)}>
							{value === "all" ? "ทั้งหมด" : value === "talk" ? "กลุ่ม" : value === "oa" ? "OA" : "OP"}
						</button>
					))}
				</div>
			</div>

			<div
				className="chat-card-grid"
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
					gap: "var(--space-xs)",
					maxHeight: "min(400px, 60vh)",
					overflowY: "auto",
					paddingRight: "var(--space-xs)",
				}}
			>
				{visibleChats.length === 0 && (
					<div style={{ gridColumn: "1 / -1", color: "var(--text-dim)", fontSize: "var(--text-sm)", textAlign: "center", padding: "1rem" }}>
						{chats.length === 0 ? "ยังไม่มีข้อมูล — จะแสดงหลังจากเข้าสู่ระบบสำเร็จ" : "ไม่พบห้องที่ค้นหา"}
					</div>
				)}
				{visibleChats.map((chat) => {
					const isSelected = selectedMids.includes(chat.mid);
					return (
						<div
							key={chat.mid}
							onClick={() => handleToggle(chat.mid)}
							style={{
								display: "flex",
								flexDirection: "column",
								alignItems: "center",
								gap: "0.5rem",
								background: isSelected ? "var(--bg-panel-raised)" : "var(--bg-inset)",
								border: `1px solid ${isSelected ? "var(--signal-go-dim)" : "var(--border-hair)"}`,
								borderRadius: "var(--radius-sm)",
								padding: "0.6rem",
								cursor: "pointer",
								color: "var(--text-primary)",
								transition: "all 0.15s ease",
								textAlign: "center",
							}}
							onMouseEnter={(e) => {
								if (!isSelected) {
									e.currentTarget.style.borderColor = "var(--signal-go-dim)";
									e.currentTarget.style.background = "var(--bg-panel-raised)";
								}
							}}
							onMouseLeave={(e) => {
								if (!isSelected) {
									e.currentTarget.style.borderColor = "var(--border-hair)";
									e.currentTarget.style.background = "var(--bg-inset)";
								}
							}}
						>
							{/* TOP: Chip */}
							<span className="chip chip--idle" style={{ fontSize: "var(--text-xs)", padding: "0.3rem 0.6rem" }}>
								{chat.surface}
							</span>

							{/* MIDDLE: Name */}
							<span
								style={{
									fontSize: "var(--text-sm)",
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap",
									width: "100%",
									fontWeight: isSelected ? 600 : 400,
								}}
							>
								{chat.name ?? chat.mid}
							</span>

							{isSelected && (
								<span className="chip chip--go" style={{ fontSize: "var(--text-xs)" }}>
									เลือกไว้ทดสอบ
								</span>
							)}

							{/* Auto-reply gate — persisted server-side, controls whether the bot ever replies here.
							    stopPropagation so clicking the switch doesn't also toggle the card's test-selection. */}
							<div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }} onClick={(e) => e.stopPropagation()}>
								<span
									style={{
										fontSize: "var(--text-xs)",
										fontWeight: 700,
										color: chat.enabled ? "var(--signal-go)" : "var(--text-secondary)",
									}}
								>
									ตอบอัตโนมัติ
								</span>
								<ToggleSwitch isSelected={!!chat.enabled} onToggle={() => onToggleEnabled(chat)} />
							</div>

							{/* OpenChat-only: LINE's classic group protocol has no admin
							    role to gate on, so this never applies to "talk" rows. */}
							{chat.surface === "square" && (
								<>
									<AdminOnlyControl botId={botId} chat={chat} onToggleAdminOnly={onToggleAdminOnly} />
									<div style={{ fontSize: "0.6875rem", color: "var(--text-dim)", textAlign: "center" }}>
										{adminsByMid[chat.mid] === undefined
											? "กำลังตรวจ admin…"
											: adminsByMid[chat.mid]!.length === 0
												? "ยังไม่ทราบ admin ในห้องนี้"
												: `admin: ${adminsByMid[chat.mid]!.map((m) => m.displayName).join(", ")}`}
									</div>
									{hasSiblings && <RoomBotsPanel botId={botId} mid={chat.mid} />}
								</>
							)}
						</div>
					);
				})}
			</div>

			{chats.length > 0 && (
				<p
					style={{
						marginTop: "var(--space-sm)",
						fontSize: "var(--text-xs)",
						color: "var(--text-dim)",
					}}
				>
					รวม {chats.length} ห้องแชท {selectedMids.length > 0 && `· เลือก ${selectedMids.length}`}
				</p>
			)}
		</section>
	);
}
