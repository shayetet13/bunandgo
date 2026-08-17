import { laneRoutingState } from "../lib/lane-routing-state.ts";
import { formatMs } from "../lib/format-ms.ts";
import type { Bot, LaneRaceSnapshot } from "../lib/types.ts";

interface LaneRacePanelProps {
	race: LaneRaceSnapshot;
	bots: Bot[];
}

function shortOrigin(origin: string): string {
	try {
		return new URL(origin).hostname;
	} catch {
		return origin;
	}
}

function historyTime(ts: number): string {
	return new Date(ts).toLocaleString("th-TH", {
		day: "2-digit",
		month: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

export function LaneRacePanel({ race, bots }: LaneRacePanelProps) {
	const botNames = new Map(bots.map((bot) => [bot.id, bot.name]));
	const history = [
		...race.events.map((event) => ({ kind: "lane" as const, ts: event.ts, event })),
		...(race.latency ?? []).map((sample) => ({ kind: "latency" as const, ts: sample.ts, sample })),
	].sort((left, right) => right.ts - left.ts).slice(0, 200);

	return (
		<section className="panel" style={{ padding: "var(--space-md)" }}>
			<div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: "var(--space-md)", flexWrap: "wrap" }}>
				<div>
					<div className="label" style={{ color: "var(--signal-go)" }}>LANE RACE</div>
					<div style={{ fontWeight: 700, marginTop: 3 }}>แข่งความเร็วของเลน · สดและย้อนหลัง {race.retentionDays || 30} วัน</div>
					<p className="hint" style={{ margin: "0.35rem 0 0" }}>HOT = ต่ำกว่า 20ms · WARM = 20–ต่ำกว่า 23ms · ตั้งแต่ 23ms ตัดจากเส้นทางส่ง · ดาวเป็นคะแนนย้อนหลังเท่านั้น</p>
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
					const stateClass = state === "HOT" ? "chip--go" : state === "WARM" ? "chip--warn" : state === "COOL" ? "chip--bad" : "";
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

			<div style={{ marginTop: "var(--space-md)", paddingTop: "var(--space-md)", borderTop: "1px solid var(--border-hair)" }}>
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "var(--space-sm)", flexWrap: "wrap" }}>
					<div className="label">LANE + LATENCY LOG · {history.length}</div>
					<span className="hint" style={{ fontSize: "var(--text-xs)" }}>เรียงเหตุการณ์ล่าสุด · เก็บย้อนหลัง {race.retentionDays || 30} วัน</span>
				</div>
				<div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 440, overflowY: "auto", marginTop: "var(--space-sm)", paddingRight: 3 }}>
					{history.length === 0 && <div className="hint">ยังไม่มีเหตุการณ์เลนหรือ latency ให้แสดง</div>}
					{history.map((item, index) => {
						if (item.kind === "lane") {
							const event = item.event;
							return (
								<div key={`lane-${event.ts}-${event.laneId}-${event.role}-${index}`} style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--space-xs)", padding: "0.48rem 0.6rem", background: "var(--bg-inset)", border: "1px solid var(--border-hair)", borderRadius: "var(--radius-sm)" }}>
									<span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", whiteSpace: "nowrap" }}>{historyTime(event.ts)}</span>
									<span className="chip chip--idle" style={{ fontSize: "var(--text-xs)" }}>{event.role.toUpperCase()}</span>
									<span style={{ fontSize: "var(--text-sm)", fontWeight: 700 }}>Lane {event.laneId}</span>
									<span className="hint" style={{ fontSize: "var(--text-xs)", flex: 1 }}>{shortOrigin(event.origin)}</span>
									<span className={`chip ${event.result === "star" ? "chip--go" : "chip--warn"}`} style={{ fontSize: "var(--text-xs)" }}>{event.result === "star" ? "⭐" : "🍌"} RTT {formatMs(event.rttMs)}</span>
								</div>
							);
						}
						const sample = item.sample;
						const breakdown = sample.breakdown;
						return (
							<div key={`latency-${sample.ts}-${sample.botId}-${index}`} style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--space-xs)", padding: "0.48rem 0.6rem", background: "var(--bg-inset)", border: "1px solid var(--border-hair)", borderRadius: "var(--radius-sm)" }}>
								<span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", whiteSpace: "nowrap" }}>{historyTime(sample.ts)}</span>
								<span className={`chip ${sample.ok ? "chip--go" : "chip--bad"}`} style={{ fontSize: "var(--text-xs)" }}>LATENCY</span>
								<span style={{ fontSize: "var(--text-sm)", fontWeight: 700 }}>{botNames.get(sample.botId) ?? `Bot ${sample.botId}`}</span>
								<span className="hint" style={{ fontSize: "var(--text-xs)" }}>{sample.surface.toUpperCase()} · {sample.source === "auto" ? "AUTO" : "TEST"}</span>
								{sample.textPreview && <span className="hint" title={sample.textPreview} style={{ fontSize: "var(--text-xs)", flex: 1, minWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sample.textPreview}</span>}
								{breakdown && <span className="hint mono" style={{ fontSize: "var(--text-xs)", whiteSpace: "nowrap" }}>LINE {formatMs(breakdown.lineMs)} · CODE {formatMs(breakdown.codeMs)}{breakdown.inboundMs !== undefined ? ` · IN ${formatMs(breakdown.inboundMs)}` : ""}</span>}
								<span className={`chip ${sample.ok ? "chip--go" : "chip--bad"}`} style={{ fontSize: "var(--text-xs)" }}>TOTAL {formatMs(sample.latencyMs)}</span>
							</div>
						);
					})}
				</div>
			</div>
		</section>
	);
}
