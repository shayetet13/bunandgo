import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import type { ActiveSessionInfo, Anomaly, AnomalySummaryRow, Bot, BotEvent, LatencySample, UserActionLogEntry } from "../lib/types.ts";

interface LogsPageProps {
	bots: Bot[];
	onNotify: (message: string) => void;
}

type LogTab = "anomalies" | "botEvents" | "userActions" | "latency";

const TABS: Array<{ key: LogTab; label: string }> = [
	{ key: "anomalies", label: "การรบกวน" },
	{ key: "botEvents", label: "เหตุการณ์บอท" },
	{ key: "userActions", label: "การกระทำผู้ใช้" },
	{ key: "latency", label: "ความเร็ว" },
];

/**
 * What each anomaly kind means, in the terms someone debugging "the bot
 * did not answer" is actually thinking in. Kept next to the table rather
 * than in a help page — the whole point of this tab is that the log alone
 * is enough to act on.
 */
const ANOMALY_LABELS: Record<string, { label: string; hint: string }> = {
	reply_destroyed: { label: "ข้อความถูกลบ", hint: "มีคนในห้องลบข้อความ ถ้าเป็นของบอทเราระบบจะส่งซ้ำให้อัตโนมัติ" },
	reply_resent: { label: "ส่งซ้ำแล้ว", hint: "ตอบโต้การลบด้วยการส่งข้อความเดิมอีกครั้ง" },
	reply_invisible: { label: "ส่งแล้วแต่ไม่อยู่ในห้อง", hint: "LINE รับข้อความไว้ แต่อ่านห้องย้อนกลับแล้วไม่พบ — บัญชีน่าจะโดนกรอง" },
	send_rejected: { label: "LINE ปฏิเสธข้อความ", hint: "LINE ตอบสถานะที่ไม่ใช่ SENT — บัญชีน่าจะถูกจำกัดสิทธิ์ในห้องนั้น" },
	send_dropped: { label: "ลิมิตเราเองบล็อก", hint: "ลิมิตการส่งของเราเองไม่ยอมให้ตอบ — ถ้าเจอบ่อยแปลว่าโดนยิงถี่จนเราเงียบเอง" },
	send_failed: { label: "ส่งไม่สำเร็จ", hint: "การส่งไปยัง LINE เกิดข้อผิดพลาด" },
	duplicate_incoming: { label: "ข้อความเข้าซ้ำ", hint: "ข้อความเดิมถูกส่งเข้ามาซ้ำ อาจเป็นการยิงถี่เพื่อกวน" },
	inbound_slow: { label: "LINE ส่งถึงเราช้า", hint: "LINE ใช้เวลานานกว่าจะส่งข้อความถึงบอทเรา — เวลานี้หมดไปก่อนบอทจะเริ่มทำงาน จึงแพ้ได้ทั้งที่บอทเราเร็ว" },
	members_unreadable: { label: "อ่านสมาชิกห้องไม่ได้", hint: "ดึงรายชื่อ/สิทธิ์ในห้องไม่สำเร็จ อาจเป็นสัญญาณว่าถูกจำกัดสิทธิ์" },
	listener_stopped: { label: "สตรีมรับข้อความหยุด", hint: "บอทหยุดได้ยินข้อความใหม่ กำลังเชื่อมต่อใหม่" },
	square_access_denied: { label: "LINE ปฏิเสธสิทธิ์ห้อง", hint: "บัญชีนี้อ่าน OpenChat ห้องนั้นไม่ได้แล้ว ระบบหยุด poll ซ้ำเพื่อไม่ให้เกิด retry flood — ตรวจสมาชิกห้อง แล้วกดเริ่ม/สแกน QR ใหม่" },
	id_lock_mismatch: { label: "บัญชี LINE ไม่ตรงกับที่ผูกไว้", hint: "มีคนพยายามสแกน QR บอทนี้ด้วยบัญชี LINE อื่นที่ไม่ใช่บัญชีแรกที่เคยเข้าสู่ระบบสำเร็จ ระบบปฏิเสธอัตโนมัติ" },
};

const SEVERITY_CHIP: Record<string, string> = {
	critical: "chip--bad",
	warn: "chip--warn",
	info: "chip--idle",
};

const USER_ACTION_LABELS: Record<string, string> = {
	"auth.login.success": "เข้าสู่ระบบสำเร็จ",
	"auth.login.failed": "เข้าสู่ระบบไม่สำเร็จ",
	"auth.login.throttled": "ล็อกอินถูกจำกัดชั่วคราว",
	"bot.create": "สร้างบอท",
	"system.worker.restart.requested": "สั่งรีสตาร์ท linebot-worker",
	"user.set_exempt_id_lock": "ตั้งค่าบัญชีทดสอบ (ยกเว้นล็อกบัญชี LINE)",
	"bot.reset_id_lock": "รีเซ็ตล็อกบัญชี LINE ของบอท",
};

function userActionLabel(action: string): string {
	return USER_ACTION_LABELS[action] ?? action;
}

function userActionDetail(detail: string | null): string | null {
	if (!detail) return null;
	try {
		const value = JSON.parse(detail) as Record<string, unknown>;
		if (typeof value.botName === "string") {
			return `ชื่อบอท: ${value.botName}${typeof value.botId === "number" ? ` (ID ${value.botId})` : ""}`;
		}
		if (typeof value.ip === "string") return `IP: ${value.ip}`;
	} catch {
		// Older audit records can contain arbitrary text; display it as-is.
	}
	return detail;
}

function toDateInputValue(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function startOfDayMs(dateInput: string): number {
	return new Date(`${dateInput}T00:00:00`).getTime();
}

function endOfDayMs(dateInput: string): number {
	return new Date(`${dateInput}T23:59:59.999`).getTime();
}

const selectStyle = {
	background: "var(--bg-inset)",
	border: "1px solid var(--border-hair)",
	borderRadius: "var(--radius-sm)",
	padding: "0.45rem 0.6rem",
	color: "var(--text-primary)",
	fontSize: "var(--text-sm)",
};

export function LogsPage({ bots, onNotify }: LogsPageProps) {
	const [tab, setTab] = useState<LogTab>("botEvents");
	const [selectedBotId, setSelectedBotId] = useState<number | undefined>(bots[0]?.id);
	const [from, setFrom] = useState(() => toDateInputValue(new Date(Date.now() - 6 * 86_400_000)));
	const [to, setTo] = useState(() => toDateInputValue(new Date()));
	const [loading, setLoading] = useState(false);
	const [botEvents, setBotEvents] = useState<BotEvent[]>([]);
	const [userActions, setUserActions] = useState<UserActionLogEntry[]>([]);
	const [activeSessions, setActiveSessions] = useState<ActiveSessionInfo[]>([]);
	const [latency, setLatency] = useState<LatencySample[]>([]);
	const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
	const [anomalySummary, setAnomalySummary] = useState<AnomalySummaryRow[]>([]);
	const [anomalyKind, setAnomalyKind] = useState<string>("");
	const [allBots, setAllBots] = useState(false);
	// Room names for the mids the log stores. A raw mid is unreadable, and
	// "which room" is the first thing anyone reading this tab wants.
	const [chatNames, setChatNames] = useState<Record<string, string>>({});

	function chatName(mid: string): string {
		return chatNames[mid] ?? `${mid.slice(0, 10)}…`;
	}

	useEffect(() => {
		if (selectedBotId === undefined && bots.length > 0) setSelectedBotId(bots[0]!.id);
	}, [bots, selectedBotId]);

	// A filter change (bot/tab/kind) can fire a new `load()` before a
	// slower, older request for the *previous* filter resolves — without
	// this token, that stale response would land last and overwrite what's
	// now on screen for the filter the admin is actually looking at. Every
	// call to `load()` (auto-refresh on filter change, or the manual "ดูข้อมูล"
	// button) claims the current token; a response only commits state if
	// its token is still the latest by the time it arrives.
	const loadTokenRef = useRef(0);

	async function load() {
		const token = ++loadTokenRef.current;
		setLoading(true);
		const fromMs = startOfDayMs(from);
		const toMs = endOfDayMs(to);
		try {
			if (tab === "anomalies") {
				const botFilter = allBots ? undefined : selectedBotId;
				const [rows, summary] = await Promise.all([
					api.anomalies({ botId: botFilter, kind: anomalyKind || undefined, since: fromMs }),
					api.anomalySummary(botFilter),
				]);
				// Best effort: a room whose name will not load still shows a
				// shortened mid, which is enough to correlate rows.
				const botIds = allBots ? [...new Set(rows.map((row) => row.bot_id).filter((id): id is number => id !== null))] : botFilter === undefined ? [] : [botFilter];
				const chatLists = await Promise.all(botIds.map((id) => api.listChats(id).catch(() => [])));
				if (token !== loadTokenRef.current) return;
				setAnomalies(rows.filter((row) => row.ts <= toMs));
				setAnomalySummary(summary);
				setChatNames(Object.fromEntries(chatLists.flat().map((chat) => [chat.mid, chat.name ?? chat.mid])));
			} else if (tab === "botEvents") {
				if (selectedBotId === undefined) return;
				const rows = await api.botEvents(selectedBotId, fromMs, toMs);
				if (token !== loadTokenRef.current) return;
				setBotEvents(rows);
			} else if (tab === "userActions") {
				const [rows, sessions] = await Promise.all([api.userActionLog(fromMs, toMs), api.activeSessions()]);
				if (token !== loadTokenRef.current) return;
				setUserActions(rows);
				setActiveSessions(sessions);
			} else {
				const rows = await api.metricsHistoryRange(fromMs, toMs);
				if (token !== loadTokenRef.current) return;
				setLatency(rows);
			}
		} catch (error) {
			if (token === loadTokenRef.current) onNotify(error instanceof Error ? error.message : String(error));
		} finally {
			if (token === loadTokenRef.current) setLoading(false);
		}
	}

	useEffect(() => {
		void load();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [tab, selectedBotId, anomalyKind, allBots]);

	function formatTs(ts: number): string {
		return new Date(ts).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "medium" });
	}

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: "var(--space-md)" }}>
			<section className="panel responsive-toolbar" style={{ padding: "var(--space-md)", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-sm)" }}>
				<div className="chat-filter-tabs">
					{TABS.map(({ key, label }) => (
						<button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{label}</button>
					))}
				</div>

				{tab !== "userActions" && (
					<>
						<label className="label" style={{ marginLeft: "var(--space-sm)" }}>บอท</label>
						<select
							value={allBots && tab === "anomalies" ? "" : selectedBotId ?? ""}
							onChange={(e) => {
								if (e.target.value === "") {
									setAllBots(true);
									return;
								}
								setAllBots(false);
								setSelectedBotId(Number(e.target.value));
							}}
							style={selectStyle}
						>
							{tab === "anomalies" && <option value="">ทุกบอท</option>}
							{bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
						</select>
					</>
				)}

				{tab === "anomalies" && (
					<>
						<label className="label">ประเภท</label>
						<select value={anomalyKind} onChange={(e) => setAnomalyKind(e.target.value)} style={selectStyle}>
							<option value="">ทั้งหมด</option>
							{Object.entries(ANOMALY_LABELS).map(([kind, { label }]) => (
								<option key={kind} value={kind}>{label}</option>
							))}
						</select>
					</>
				)}

				<label className="label">จาก</label>
				<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={selectStyle} max={to} />
				<label className="label">ถึง</label>
				<input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={selectStyle} min={from} />
				<button className="ghost-button" onClick={() => void load()} disabled={loading}>{loading ? "กำลังโหลด…" : "ดูข้อมูล"}</button>

				<p className="hint" style={{ margin: 0, width: "100%" }}>
					ประวัติการทำงานล้างทุกวัน 23:00 น. (เวลาไทย) ส่วนบันทึกผู้ใช้/ความปลอดภัยเก็บย้อนหลัง 90 วัน
				</p>
			</section>

			{tab === "anomalies" && (
				<>
					<section className="panel" style={{ padding: "var(--space-md)" }}>
						<div className="label" style={{ marginBottom: "var(--space-xs)" }}>สรุป 24 ชั่วโมงล่าสุด</div>
						{anomalySummary.length === 0
							? <p className="hint" style={{ margin: 0 }}>ไม่พบการรบกวนใน 24 ชั่วโมงที่ผ่านมา — บอทตอบได้ตามปกติทุกครั้ง</p>
							: (
								<div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-xs)" }}>
									{anomalySummary.map((row) => (
										<span
											key={`${row.kind}:${row.severity}`}
											className={`chip ${SEVERITY_CHIP[row.severity] ?? "chip--idle"}`}
											style={{ fontSize: "var(--text-xs)" }}
											title={ANOMALY_LABELS[row.kind]?.hint ?? row.kind}
										>
											{ANOMALY_LABELS[row.kind]?.label ?? row.kind} · {row.count}
										</span>
									))}
								</div>
							)}
					</section>

					<section className="panel" style={{ padding: "var(--space-md)" }}>
						<div className="label" style={{ marginBottom: "var(--space-xs)" }}>บันทึกการรบกวน · {anomalies.length}</div>
						<p className="hint" style={{ margin: "0 0 var(--space-sm)" }}>
							ทุกอย่างที่ขวางไม่ให้บอทตอบได้ตามที่ควรจะเป็น — ถูกลบ, ส่งแล้วไม่ขึ้น, ลิมิตเราเองบล็อก, สตรีมหยุด
						</p>
						<div style={{ display: "flex", flexDirection: "column", gap: "var(--space-xs)", maxHeight: 480, overflowY: "auto" }}>
							{anomalies.length === 0 && <p className="hint">ไม่มีข้อมูลในช่วงที่เลือก</p>}
							{anomalies.map((row) => {
								const meta = ANOMALY_LABELS[row.kind];
								return (
									<div
										key={row.id}
										className="rule-row"
										style={{
											display: "flex",
											flexWrap: "wrap",
											gap: "var(--space-sm)",
											alignItems: "center",
											padding: "0.5rem 0.7rem",
											background: "var(--bg-inset)",
											border: `1px solid ${row.severity === "critical" ? "var(--signal-bad-dim, var(--border-hair))" : "var(--border-hair)"}`,
											borderRadius: "var(--radius-sm)",
										}}
									>
										<span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", whiteSpace: "nowrap" }}>{formatTs(row.ts)}</span>
										<span className={`chip ${SEVERITY_CHIP[row.severity] ?? "chip--idle"}`} style={{ fontSize: "var(--text-xs)" }} title={meta?.hint ?? row.kind}>
											{meta?.label ?? row.kind}
										</span>
										{allBots && row.bot_id !== null && (
											<span className="chip chip--idle" style={{ fontSize: "var(--text-xs)" }}>
												{bots.find((bot) => bot.id === row.bot_id)?.name ?? `bot ${row.bot_id}`}
											</span>
										)}
										{row.chat_mid && (
											<span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
												{chatName(row.chat_mid)}
											</span>
										)}
										<span style={{ fontSize: "var(--text-sm)", flex: 1, minWidth: 200 }}>{row.detail}</span>
									</div>
								);
							})}
						</div>
					</section>
				</>
			)}

			{tab === "botEvents" && (
				<section className="panel" style={{ padding: "var(--space-md)" }}>
					<div className="label" style={{ marginBottom: "var(--space-xs)" }}>เหตุการณ์บอท · {botEvents.length}</div>
					<div style={{ display: "flex", flexDirection: "column", gap: "var(--space-xs)", maxHeight: 480, overflowY: "auto" }}>
						{botEvents.length === 0 && <p className="hint">ไม่มีข้อมูลในช่วงที่เลือก</p>}
						{botEvents.map((event) => (
							<div key={event.id} className="rule-row" style={{ display: "flex", gap: "var(--space-sm)", padding: "0.5rem 0.7rem", background: "var(--bg-inset)", border: "1px solid var(--border-hair)", borderRadius: "var(--radius-sm)" }}>
								<span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", whiteSpace: "nowrap" }}>{formatTs(event.ts)}</span>
								<span className="chip chip--idle" style={{ fontSize: "var(--text-xs)" }}>{event.type}</span>
								<span style={{ fontSize: "var(--text-sm)", flex: 1 }}>{event.message}</span>
							</div>
						))}
					</div>
				</section>
			)}

			{tab === "userActions" && (
				<>
					<section className="panel" style={{ padding: "var(--space-md)" }}>
						<div className="label" style={{ marginBottom: "var(--space-xs)" }}>ออนไลน์ตอนนี้ · {activeSessions.length}</div>
						{activeSessions.length === 0
							? <p className="hint" style={{ margin: 0 }}>ไม่มีใครล็อกอินอยู่ในระบบขณะนี้</p>
							: (
								<div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-xs)" }}>
									{activeSessions.map((session) => (
										<span
											key={`${session.userId}:${session.createdAt}`}
											className="chip chip--go"
											style={{ fontSize: "var(--text-xs)" }}
											title={`เข้าสู่ระบบ ${formatTs(session.createdAt)} · ใช้งานล่าสุด ${formatTs(session.lastSeenAt)}`}
										>
											{session.username} ({session.role === "admin" ? "แอดมิน" : "ผู้ใช้"})
										</span>
									))}
								</div>
							)}
					</section>
					<section className="panel" style={{ padding: "var(--space-md)" }}>
						<div className="label" style={{ marginBottom: "var(--space-xs)" }}>การกระทำผู้ใช้ · {userActions.length}</div>
						<div style={{ display: "flex", flexDirection: "column", gap: "var(--space-xs)", maxHeight: 480, overflowY: "auto" }}>
							{userActions.length === 0 && <p className="hint">ไม่มีข้อมูลในช่วงที่เลือก</p>}
							{userActions.map((entry) => (
								<div key={entry.id} className="rule-row" style={{ display: "flex", gap: "var(--space-sm)", padding: "0.5rem 0.7rem", background: "var(--bg-inset)", border: "1px solid var(--border-hair)", borderRadius: "var(--radius-sm)" }}>
									<span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", whiteSpace: "nowrap" }}>{formatTs(entry.ts)}</span>
									<span className="chip chip--go" style={{ fontSize: "var(--text-xs)" }}>{entry.username}</span>
									<span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{userActionLabel(entry.action)}</span>
									{userActionDetail(entry.detail) && <span style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{userActionDetail(entry.detail)}</span>}
								</div>
							))}
						</div>
					</section>
				</>
			)}

			{tab === "latency" && (
				<section className="panel" style={{ padding: "var(--space-md)" }}>
					<div className="label" style={{ marginBottom: "var(--space-xs)" }}>ความเร็ว (ย้อนหลัง) · {latency.length}</div>
					<div style={{ display: "flex", flexDirection: "column", gap: "var(--space-xs)", maxHeight: 480, overflowY: "auto" }}>
						{latency.length === 0 && <p className="hint">ไม่มีข้อมูลในช่วงที่เลือก</p>}
						{latency.map((sample, i) => (
							<div key={i} className="rule-row" style={{ display: "flex", gap: "var(--space-sm)", padding: "0.5rem 0.7rem", background: "var(--bg-inset)", border: "1px solid var(--border-hair)", borderRadius: "var(--radius-sm)" }}>
								<span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", whiteSpace: "nowrap" }}>{formatTs(sample.ts)}</span>
								<span className="chip chip--idle" style={{ fontSize: "var(--text-xs)" }}>{sample.surface}</span>
								<span className={`chip ${sample.ok ? "chip--go" : "chip--bad"}`} style={{ fontSize: "var(--text-xs)" }}>{sample.latencyMs.toFixed(1)} ms</span>
								<span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sample.textPreview}</span>
							</div>
						))}
					</div>
				</section>
			)}
		</div>
	);
}
