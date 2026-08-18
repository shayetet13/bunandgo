import { type FormEvent, useState } from "react";
import type { Bot, BotStatus, LoginPhase, UserRole } from "../lib/types.ts";
import { groupBotsByOwner } from "../lib/group-bots.ts";
import { useOwnerNames } from "../lib/useOwnerNames.ts";
import { QrPanel } from "./QrPanel.tsx";
import { StartConfirmPanel } from "./StartConfirmPanel.tsx";

export interface QrState {
	url?: string;
	pincode?: string;
	phase?: LoginPhase;
}

export interface ConfirmState {
	token: string;
	url: string;
}

interface BotsPanelProps {
	bots: Bot[];
	role: UserRole;
	selectedBotId?: number;
	onSelect: (bot: Bot) => void;
	qrByBot: Record<number, QrState>;
	confirmByBot: Record<number, ConfirmState>;
	onCreateBot: (name: string) => void;
	onStart: (botId: number) => void;
	onStop: (botId: number) => void;
	onDelete: (botId: number) => void;
	onResetIdLock: (botId: number) => void;
	onForceRelogin: (botId: number) => void;
}

const STATUS_COLOR: Record<BotStatus, string> = {
	offline: "var(--signal-idle)",
	connecting: "var(--signal-warn)",
	online: "var(--signal-go)",
};

const STATUS_LABEL: Record<BotStatus, string> = {
	offline: "ออฟไลน์",
	connecting: "กำลังเชื่อมต่อ",
	online: "ออนไลน์",
};

const actionBtnStyle = {
	border: "1px solid var(--border-strong)",
	background: "transparent",
	color: "var(--text-secondary)",
	borderRadius: "var(--radius-sm)",
	padding: "0.25rem 0.6rem",
	fontSize: "var(--text-xs)",
	cursor: "pointer",
};

export function BotsPanel({ bots, role, selectedBotId, onSelect, qrByBot, confirmByBot, onCreateBot, onStart, onStop, onDelete, onResetIdLock, onForceRelogin }: BotsPanelProps) {
	const [showForm, setShowForm] = useState(false);
	const [name, setName] = useState("");
	const [confirmDeleteId, setConfirmDeleteId] = useState<number>();
	const [confirmResetIdLockId, setConfirmResetIdLockId] = useState<number>();
	const [confirmForceReloginId, setConfirmForceReloginId] = useState<number>();
	const ownerNames = useOwnerNames(role);
	const groups = groupBotsByOwner(bots);

	function submit(e: FormEvent) {
		e.preventDefault();
		if (!name.trim()) return;
		onCreateBot(name.trim());
		setName("");
		setShowForm(false);
	}

	return (
		<section className="panel" style={{ padding: "var(--space-md)" }}>
			<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-sm)" }}>
				<div className="label">บอท · {bots.length}</div>
				<button
					onClick={() => setShowForm((s) => !s)}
					style={{
						background: showForm ? "transparent" : "var(--signal-go)",
						color: showForm ? "var(--text-secondary)" : "#04170c",
						border: `1px solid ${showForm ? "var(--border-strong)" : "transparent"}`,
						borderRadius: "var(--radius-sm)",
						padding: "0.3rem 0.7rem",
						fontSize: "var(--text-xs)",
						fontWeight: 700,
						cursor: "pointer",
					}}
				>
					{showForm ? "ยกเลิก" : "+ สร้างบอท"}
				</button>
			</div>
			<p className="hint" style={{ margin: "0 0 var(--space-sm)" }}>
				แต่ละบอทคือบัญชี LINE คนละบัญชี แยกกฎและห้องแชทกันเด็ดขาด
			</p>

			{showForm && (
				<form className="bot-create-form" onSubmit={submit} style={{ display: "flex", gap: "var(--space-xs)", marginBottom: "var(--space-md)" }}>
					<input
						autoFocus
						placeholder="ชื่อบอท (เช่น กลุ่มหวย 1)"
						value={name}
						onChange={(e) => setName(e.target.value)}
						style={{
							flex: 1,
							background: "var(--bg-inset)",
							border: "1px solid var(--border-hair)",
							borderRadius: "var(--radius-sm)",
							padding: "0.45rem 0.6rem",
							color: "var(--text-primary)",
							fontSize: "var(--text-sm)",
						}}
					/>
					<button
						type="submit"
						style={{
							background: "var(--accent-line)",
							color: "#04170c",
							border: "none",
							borderRadius: "var(--radius-sm)",
							padding: "0.45rem 0.9rem",
							fontWeight: 700,
							cursor: "pointer",
							whiteSpace: "nowrap",
						}}
					>
						สร้าง &amp; เข้าสู่ระบบ
					</button>
				</form>
			)}

			{bots.length === 0 && !showForm && (
				<div style={{ color: "var(--text-dim)", fontSize: "var(--text-sm)" }}>
					ยังไม่มีบอท — สร้างบอทเพื่อรับ QR สำหรับเข้าสู่ระบบ LINE
				</div>
			)}
			{groups.map((group) => (
				<div key={group.key} style={{ marginBottom: "var(--space-md)" }}>
					{groups.length > 1 && (
						<div className="label" style={{ margin: "0 0 var(--space-xs)", color: "var(--text-dim)" }}>
							{group.ownerUserId === null
								? "ไม่มีเจ้าของ"
								: ownerNames[group.ownerUserId] ?? `ผู้ใช้ #${group.ownerUserId}`}
							{group.bots.length > 1 ? ` · บอทพี่น้อง ${group.bots.length} ตัว` : ""}
						</div>
					)}
					<div className="bots-grid">
						{group.bots.map((bot) => {
							const pendingConfirm = confirmByBot[bot.id];
							return (
							<div
								key={bot.id}
								style={{
									display: "flex",
									flexDirection: "column",
									gap: "var(--space-xs)",
									background: bot.id === selectedBotId ? "var(--bg-panel-raised)" : "var(--bg-inset)",
									border: `1px solid ${bot.id === selectedBotId ? "var(--signal-go-dim)" : "var(--border-hair)"}`,
									borderRadius: "var(--radius-sm)",
									padding: "0.55rem 0.7rem",
								}}
							>
								<button
									onClick={() => onSelect(bot)}
									style={{
										display: "flex",
										alignItems: "center",
										gap: "var(--space-sm)",
										textAlign: "left",
										background: "transparent",
										border: "none",
										padding: 0,
										cursor: "pointer",
										color: "var(--text-primary)",
									}}
								>
									<span
										style={{
											width: 8,
											height: 8,
											borderRadius: 999,
											background: STATUS_COLOR[bot.status],
											boxShadow: bot.status !== "offline" ? `0 0 8px ${STATUS_COLOR[bot.status]}` : undefined,
											flexShrink: 0,
										}}
									/>
									<span style={{ fontSize: "var(--text-sm)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
										bot{bot.slot} · {bot.name}
									</span>
									<span className="label">{STATUS_LABEL[bot.status]}</span>
								</button>

								{role === "admin" && bot.lockedLineMid && (
									<div className="label" style={{ color: "var(--text-dim)", fontSize: "var(--text-xs)" }}>
										ล็อกกับ: {bot.lockedLineDisplayName ?? "(ยังไม่มีชื่อบันทึก — รอสแกน QR ใหม่)"}
									</div>
								)}

								<div className="bot-card-actions" style={{ display: "flex", gap: "var(--space-xs)" }}>
									{bot.status === "offline" ? (
										pendingConfirm ? (
											<button disabled style={{ ...actionBtnStyle, cursor: "default" }}>
												รอการยืนยัน…
											</button>
										) : (
											<button onClick={() => onStart(bot.id)} style={{ ...actionBtnStyle, color: "var(--signal-go)", borderColor: "var(--signal-go-dim)" }}>
												▶ เริ่ม
											</button>
										)
									) : (
										<button onClick={() => onStop(bot.id)} style={{ ...actionBtnStyle, color: "var(--signal-warn)", borderColor: "var(--signal-warn-dim)" }}>
											■ หยุด
										</button>
									)}

									{confirmDeleteId === bot.id ? (
										<>
											<button
												onClick={() => {
													onDelete(bot.id);
													setConfirmDeleteId(undefined);
												}}
												style={{ ...actionBtnStyle, color: "var(--signal-bad)", borderColor: "var(--signal-bad-dim)", fontWeight: 700 }}
											>
												ยืนยันลบ?
											</button>
											<button onClick={() => setConfirmDeleteId(undefined)} style={actionBtnStyle}>
												ยกเลิก
											</button>
										</>
									) : (
										<button onClick={() => setConfirmDeleteId(bot.id)} style={actionBtnStyle}>
											ลบ
										</button>
									)}

									{role === "admin" && bot.lockedLineMid && (
										confirmResetIdLockId === bot.id ? (
											<>
												<button
													onClick={() => {
														onResetIdLock(bot.id);
														setConfirmResetIdLockId(undefined);
													}}
													style={{ ...actionBtnStyle, color: "var(--signal-warn)", borderColor: "var(--signal-warn-dim)", fontWeight: 700 }}
												>
													ยืนยันรีเซ็ตล็อก?
												</button>
												<button onClick={() => setConfirmResetIdLockId(undefined)} style={actionBtnStyle}>
													ยกเลิก
												</button>
											</>
										) : (
											<button
												onClick={() => setConfirmResetIdLockId(bot.id)}
												style={actionBtnStyle}
												title="ปลดล็อกบัญชี LINE และชื่อบัญชีของบอทนี้ — จะหยุดบอทและออกจากระบบ session เดิมด้วย ใช้เมื่อบัญชีเดิมโดนแบน/ต้องเปลี่ยนบัญชีใหม่ หรือชื่อบัญชีเปลี่ยนไปจริงๆ"
											>
												รีเซ็ตล็อกบัญชี
											</button>
										)
									)}

									{role === "admin" && bot.lockedLineMid && (
										confirmForceReloginId === bot.id ? (
											<>
												<button
													onClick={() => {
														onForceRelogin(bot.id);
														setConfirmForceReloginId(undefined);
													}}
													style={{ ...actionBtnStyle, color: "var(--signal-warn)", borderColor: "var(--signal-warn-dim)", fontWeight: 700 }}
												>
													ยืนยันบังคับสแกนใหม่?
												</button>
												<button onClick={() => setConfirmForceReloginId(undefined)} style={actionBtnStyle}>
													ยกเลิก
												</button>
											</>
										) : (
											<button
												onClick={() => setConfirmForceReloginId(bot.id)}
												style={actionBtnStyle}
												title="หยุดบอทและออกจากระบบ session เดิม แต่ยังล็อกบัญชี LINE เดิมไว้ — สแกนครั้งถัดไปต้องเป็นบัญชีเดิมเท่านั้น มิฉะนั้นจะถูกปฏิเสธและแจ้งเตือน (ต่างจากรีเซ็ตล็อกที่ปลดล็อกให้บัญชีอื่นเข้าได้)"
											>
												บังคับสแกนใหม่
											</button>
										)
									)}
								</div>

								{bot.status === "offline" && pendingConfirm && (
									<StartConfirmPanel botName={`bot${bot.slot} · ${bot.name}`} confirmUrl={pendingConfirm.url} />
								)}

								{bot.status === "connecting" && (
									<QrPanel
										botName={`bot${bot.slot} · ${bot.name}`}
										qrUrl={qrByBot[bot.id]?.url}
										pincode={qrByBot[bot.id]?.pincode}
										phase={qrByBot[bot.id]?.phase}
										onCancel={() => onStop(bot.id)}
									/>
								)}
							</div>
							);
						})}
					</div>
				</div>
			))}
		</section>
	);
}
