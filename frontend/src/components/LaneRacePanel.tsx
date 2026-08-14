import { laneRoutingState } from "../lib/lane-routing-state.ts";
import type { LaneRaceSnapshot } from "../lib/types.ts";

interface LaneRacePanelProps {
	race: LaneRaceSnapshot;
}

function shortOrigin(origin: string): string {
	try {
		return new URL(origin).hostname;
	} catch {
		return origin;
	}
}

export function LaneRacePanel({ race }: LaneRacePanelProps) {
	return (
		<section className="panel" style={{ padding: "var(--space-md)" }}>
			<div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: "var(--space-md)", flexWrap: "wrap" }}>
				<div>
					<div className="label" style={{ color: "var(--signal-go)" }}>LANE RACE</div>
					<div style={{ fontWeight: 700, marginTop: 3 }}>แข่งความเร็วของเลน · สดและย้อนหลัง {race.retentionDays || 30} วัน</div>
					<p className="hint" style={{ margin: "0.35rem 0 0" }}>HOT = ผลวัดงานจริงล่าสุดยังใหม่และต่ำกว่า 23ms · COOL = ไม่ถูกเลือกใน hot path ตอนนี้ · ดาวเป็นคะแนนย้อนหลังเท่านั้น</p>
				</div>
				<div className="chip chip--go">⭐ ครบ 10 = ดาวใหญ่</div>
			</div>

			<div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: "var(--space-md)" }}>
				{race.lanes.length === 0 ? (
					<div className="hint">รอผลการส่งข้อความครั้งแรกเพื่อเริ่มการแข่งขัน</div>
				) : race.lanes.map((lane, index) => {
					const activeScore = lane.send.samples > 0 ? lane.send : lane.poll;
					const total = activeScore.stars + activeScore.bananas;
					const winRate = total ? Math.round(activeScore.stars / total * 100) : 0;
					const state = laneRoutingState(lane);
					const stateClass = state === "HOT" ? "chip--go" : state === "COOL" ? "chip--bad" : "";
					const rtt = lane.applicationRttMs ?? activeScore.avgRttMs;
					return (
						<div key={`${lane.origin}-${lane.laneId}`} style={{ display: "grid", gridTemplateColumns: "minmax(110px, 1fr) auto auto", gap: "var(--space-sm)", alignItems: "center", padding: "0.55rem 0.65rem", border: "1px solid var(--border-hair)", borderRadius: "var(--radius-sm)" }}>
							<div style={{ minWidth: 0 }}>
								<div style={{ fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>#{index + 1} · Lane {lane.laneId} <span className={`chip ${stateClass}`} style={{ marginLeft: 4 }}>{state}</span></div>
								<div className="hint" style={{ fontSize: "0.72rem" }}>{shortOrigin(lane.origin)} · {lane.state} · {rtt?.toFixed(1) ?? "—"} ms</div>
							</div>
							<div title="คะแนนส่งข้อความ" style={{ fontSize: "var(--text-sm)", whiteSpace: "nowrap" }}><span className="hint">SEND </span><span style={{ color: "var(--signal-go)", fontWeight: 700 }}>⭐ {lane.send.stars}</span> <span style={{ color: "#d7b226", fontWeight: 700 }}>🍌 {lane.send.bananas}</span>{lane.send.bigStars > 0 ? ` · 🌟 ${lane.send.bigStars}` : ""}</div>
							<div title="คะแนนรับ event" style={{ textAlign: "right", fontSize: "var(--text-sm)", whiteSpace: "nowrap" }}><span className="hint">POLL </span><span style={{ color: "var(--signal-go)", fontWeight: 700 }}>⭐ {lane.poll.stars}</span> <span style={{ color: "#d7b226", fontWeight: 700 }}>🍌 {lane.poll.bananas}</span>{lane.poll.bigStars > 0 ? ` · 🌟 ${lane.poll.bigStars}` : ` · ${winRate}%`}</div>
						</div>
					);
				})}
			</div>
		</section>
	);
}
