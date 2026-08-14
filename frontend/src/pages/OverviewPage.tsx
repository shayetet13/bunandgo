import { useEffect, useState } from "react";
import type { Bot, FastPathSnapshot, HealthStatus, LaneRaceSnapshot, LatencySample, LatencySnapshot } from "../lib/types.ts";
import { RadarVisual } from "../components/RadarVisual.tsx";
import { DispatchChart } from "../components/DispatchChart.tsx";
import { StatCard } from "../components/StatCard.tsx";
import { LatencyBreakdown } from "../components/LatencyBreakdown.tsx";
import { LaneRacePanel } from "../components/LaneRacePanel.tsx";
import { NetworkSpeedPanel } from "../components/NetworkSpeedPanel.tsx";

interface OverviewPageProps {
	bots: Bot[];
	snapshot: LatencySnapshot;
	fastSnapshot: FastPathSnapshot;
	throughputPerMin: number;
	autoReplyRatePercent: number | null;
	historySamples: LatencySample[];
	laneRace: LaneRaceSnapshot;
	health?: HealthStatus;
	wsConnected: boolean;
	onCreateBot: () => void;
	onViewFleet: () => void;
}

function receiveSourceLabel(source: "push" | "normal-poll" | "dedicated-poll" | undefined): string {
	if (source === "dedicated-poll") return "Dedicated poll (ห้อง hot)";
	if (source === "normal-poll") return "Poll ปกติ";
	if (source === "push") return "Push";
	return "ยังไม่มี event";
}

function formatUptime(totalSeconds: number): string {
	const days = Math.floor(totalSeconds / 86_400);
	const hours = Math.floor((totalSeconds % 86_400) / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	return `${days} วัน ${hours} ชม ${minutes} นาที ${seconds} วิ`;
}

/**
 * The health endpoint reports worker uptime every five seconds. Keep the
 * display ticking locally between reports, then re-base it on the next
 * report so a dashboard refresh never resets the displayed uptime.
 */
function DashboardClock({ uptimeSeconds }: { uptimeSeconds?: number }) {
	const [now, setNow] = useState(() => Date.now());
	const [uptimeBase, setUptimeBase] = useState<{ seconds: number; receivedAt: number }>();

	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 1_000);
		return () => window.clearInterval(timer);
	}, []);

	useEffect(() => {
		if (typeof uptimeSeconds === "number") setUptimeBase({ seconds: uptimeSeconds, receivedAt: Date.now() });
	}, [uptimeSeconds]);

	const liveUptime = uptimeBase
		? uptimeBase.seconds + Math.max(0, Math.floor((now - uptimeBase.receivedAt) / 1_000))
		: undefined;
	const clock = new Date(now);
	const date = new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "long", year: "numeric" }).format(clock);
	const time = new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(clock);

	return (
		<div className="panel" style={{ minWidth: 240, padding: "var(--space-md)", textAlign: "right" }}>
			<div className="label" style={{ color: "var(--signal-go)", marginBottom: "var(--space-xs)" }}>SYSTEM CLOCK · BANGKOK</div>
			<div className="mono" style={{ fontSize: "1.45rem", fontWeight: 800, lineHeight: 1.1 }}>{time}</div>
			<div className="hint" style={{ marginTop: "0.2rem" }}>{date}</div>
			<div style={{ borderTop: "1px solid var(--border-hair)", marginTop: "var(--space-sm)", paddingTop: "var(--space-sm)" }}>
				<div className="label">WORKER UPTIME</div>
				<div style={{ color: "var(--text-secondary)", fontSize: "var(--text-sm)", fontWeight: 700, marginTop: "0.15rem" }}>
					{liveUptime === undefined ? "กำลังตรวจเวลาเปิดระบบ..." : `เปิดมาแล้ว ${formatUptime(liveUptime)}`}
				</div>
			</div>
		</div>
	);
}

export function OverviewPage({
	bots,
	snapshot,
	fastSnapshot,
	throughputPerMin,
	autoReplyRatePercent,
	historySamples,
	laneRace,
	health,
	wsConnected,
	onCreateBot,
	onViewFleet,
}: OverviewPageProps) {
	const onlineCount = bots.filter((b) => b.status === "online").length;
	const infraOk = wsConnected && (health?.senderHealthy ?? false) && (health?.dbHealthy ?? false);

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: "var(--space-lg)" }}>
			<section
				className="panel"
				style={{ padding: "var(--space-xl)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-lg)", flexWrap: "wrap" }}
			>
				<div style={{ maxWidth: 560 }}>
					<div className="label" style={{ color: "var(--signal-go)", marginBottom: "var(--space-sm)" }}>
						((•)) LIVE OPERATIONS
					</div>
					<h2 style={{ margin: "0 0 var(--space-sm)", fontSize: "2.1rem", fontWeight: 800, lineHeight: 1.2 }}>
						ทุกบอทแยกอิสระ
						<br />
						<span style={{ color: "var(--signal-go)" }}>แต่ควบคุมจากที่เดียว</span>
					</h2>
					<p className="hint" style={{ marginBottom: "var(--space-md)" }}>
						ตรวจสุขภาพ ความเร็ว และอัตราตอบกลับของทุกบอทได้ในหน้าเดียว พร้อมหยุดการทำงานได้ทันทีเมื่อพบความผิดปกติ
					</p>
					<div style={{ display: "flex", gap: "var(--space-sm)" }}>
						<button
							onClick={onCreateBot}
							style={{ background: "var(--signal-go)", color: "#04170c", border: "none", borderRadius: "var(--radius-sm)", padding: "0.7rem 1.2rem", fontWeight: 700, cursor: "pointer" }}
						>
							+ สร้างบอทใหม่
						</button>
						<button
							onClick={onViewFleet}
							style={{ background: "transparent", border: "1px solid var(--border-strong)", color: "var(--text-secondary)", borderRadius: "var(--radius-sm)", padding: "0.7rem 1.2rem", cursor: "pointer" }}
						>
							ดูบอททั้งหมด
						</button>
					</div>
				</div>
				<div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "var(--space-md)", flexWrap: "wrap" }}>
					<DashboardClock uptimeSeconds={health?.uptimeSeconds} />
					<RadarVisual activeCount={onlineCount} />
				</div>
			</section>

			<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "var(--space-md)" }}>
				<StatCard label="BOT ONLINE" value={`${onlineCount}/${bots.length}`} hint={`${bots.length} ตัวทั้งหมด`} />
				<StatCard label="THROUGHPUT" value={String(throughputPerMin)} unit="msg/min" hint="ข้อความเข้าในนาทีล่าสุด" />
				<StatCard
					label="CODE P95"
					value={fastSnapshot.count > 0 ? fastSnapshot.p95.toFixed(2) : "—"}
					unit={fastSnapshot.count > 0 ? "ms" : ""}
					hint={fastSnapshot.count > 0 ? `ก่อนออกจากเครื่อง · ${fastSnapshot.count} ครั้ง · ล่าสุด: ${receiveSourceLabel(fastSnapshot.last?.receiveSource)}` : "ยังไม่มีข้อมูลรอบนี้"}
				/>
				<StatCard
					label="LINE TOTAL P95"
					value={snapshot.count > 0 ? String(Math.round(snapshot.p95)) : "—"}
					unit={snapshot.count > 0 ? "ms" : ""}
					hint={snapshot.count > 0 ? "รวม network และรอ LINE ตอบ" : "ยังไม่มีข้อมูลรอบนี้"}
				/>
				<StatCard
					label="AUTO-REPLY RATE"
					value={autoReplyRatePercent === null ? "—" : String(Math.round(autoReplyRatePercent))}
					unit={autoReplyRatePercent === null ? "" : "%"}
					hint="สัดส่วนข้อความที่บอทตอบอัตโนมัติ"
				/>
			</div>

			<LatencyBreakdown sample={snapshot.last} />

			<NetworkSpeedPanel lanes={health?.lanes ?? []} />

			<LaneRacePanel race={laneRace} />

			<div className="overview-bottom-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 300px", gap: "var(--space-lg)", alignItems: "start" }}>
				<section className="panel" style={{ padding: "var(--space-md)" }}>
					<div className="label" style={{ color: "var(--signal-go)" }}>TOTAL DISPATCH</div>
					<div style={{ fontWeight: 700, marginBottom: "var(--space-sm)" }}>ความเร็วในการส่ง (60 นาทีล่าสุด)</div>
					<DispatchChart samples={historySamples} rangeMinutes={60} />
				</section>

				<section className="panel" style={{ padding: "var(--space-md)" }}>
					<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-sm)" }}>
						<div className="label" style={{ color: "var(--signal-go)" }}>INFRASTRUCTURE</div>
						<span className={`chip ${infraOk ? "chip--go" : "chip--bad"}`}>{infraOk ? "OK" : "ปัญหา"}</span>
					</div>
					<div style={{ fontWeight: 700, marginBottom: "var(--space-sm)" }}>สุขภาพระบบ</div>
					<InfraRow label="Backend API" value={wsConnected ? "ปกติ" : "ขาดการเชื่อมต่อ"} ok={wsConnected} />
					<InfraRow label="Go dispatcher" value={health?.senderHealthy ? "ปกติ" : "ไม่ตอบสนอง"} ok={!!health?.senderHealthy} />
					<InfraRow label="ฐานข้อมูล" value={health?.dbHealthy ? "ปกติ" : "ไม่ตอบสนอง"} ok={!!health?.dbHealthy} />
					<InfraRow label="บอทออนไลน์" value={`${onlineCount} / ${bots.length}`} ok />
				</section>
			</div>
		</div>
	);
}

function InfraRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
	return (
		<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.45rem 0", borderTop: "1px solid var(--border-hair)" }}>
			<span style={{ fontSize: "var(--text-sm)" }}>{label}</span>
			<span style={{ fontSize: "var(--text-sm)", color: ok ? "var(--signal-go)" : "var(--signal-bad)", fontWeight: 700 }}>{value}</span>
		</div>
	);
}
