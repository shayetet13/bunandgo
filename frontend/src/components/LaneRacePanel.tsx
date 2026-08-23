import { laneRoutingState } from "../lib/lane-routing-state.ts";
import { formatMs } from "../lib/format-ms.ts";
import { groupLanesByWorker } from "../lib/group-lanes.ts";
import { CollapsibleSection } from "./CollapsibleSection.tsx";
import type { Bot, LaneRaceLane, LaneRaceSnapshot } from "../lib/types.ts";

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

function groupTally(lanes: readonly LaneRaceLane[]): { stars: number; bananas: number } {
	let stars = 0;
	let bananas = 0;
	for (const lane of lanes) {
		const active = lane.send.samples > 0 ? lane.send : lane.poll;
		stars += active.stars;
		bananas += active.bananas;
	}
	return { stars, bananas };
}

export function LaneRacePanel({ race, bots }: LaneRacePanelProps) {
	const botNames = new Map(bots.map((bot) => [bot.id, bot.name]));
	const groups = groupLanesByWorker(race.lanes);
	const history = [
		...race.events.map((event) => ({ kind: "lane" as const, ts: event.ts, event })),
		...(race.latency ?? []).map((sample) => ({ kind: "latency" as const, ts: sample.ts, sample })),
	]
		.sort((left, right) => right.ts - left.ts)
		.slice(0, 200);

	return (
		<section className="panel" style={{ padding: "var(--space-md)" }}>
			<div className="panel-head">
				<div>
					<div className="label">LANE RACE</div>
					<div style={{ fontWeight: 700, marginTop: 3 }}>แข่งความเร็วของเลน · สดและย้อนหลัง {race.retentionDays || 30} วัน</div>
					<p className="hint" style={{ margin: "0.35rem 0 0" }}>
						FASTEST = ผลงานจริงต่ำที่สุดของ worker นั้น · STANDBY = วัดแล้วแต่ช้ากว่า · WAIT = อุ่นแล้วและรองานจริง · ไม่มีเกณฑ์ตัดตาม ms
					</p>
				</div>
				<span className="chip">⭐ ครบ 10 = ดาวใหญ่</span>
			</div>

			<div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: "var(--space-md)" }}>
				{race.lanes.length === 0 ? (
					<div className="hint">รอผลการส่งข้อความครั้งแรกเพื่อเริ่มการแข่งขัน</div>
				) : (
					groups.map((group) => {
						const leader = group.lanes.find((lane) => lane.routingPreferred);
						const tally = groupTally(group.lanes);
						return (
							<CollapsibleSection
								key={group.key}
								title={
									<>
										{shortOrigin(group.origin)} <span className="collapsible-title-dim">· {group.workerId}</span>
									</>
								}
								meta={`${group.lanes.length} lane`}
								summary={
									<>
										{leader && <span className="chip chip--go mono">FASTEST เลน {leader.laneId}</span>}
										<span className="chip mono">
											⭐{tally.stars} 🍌{tally.bananas}
										</span>
									</>
								}
							>
								<div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
									{group.lanes.map((lane, index) => {
										const activeScore = lane.send.samples > 0 ? lane.send : lane.poll;
										const total = activeScore.stars + activeScore.bananas;
										const winRate = total ? Math.round((activeScore.stars / total) * 100) : 0;
										const state = laneRoutingState(lane);
										const stateClass = state === "FASTEST" ? "chip--go" : state === "STANDBY" ? "chip--idle" : "";
										const rtt = lane.applicationRttMs ?? activeScore.avgRttMs;
										return (
											<div key={`${lane.workerId}-${lane.origin}-${lane.laneId}`} className="lane-race-row">
												<div style={{ minWidth: 0 }}>
													<div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
														#{index + 1} · เลน {lane.laneId}{" "}
														<span className={`chip ${stateClass}`} style={{ marginLeft: 4 }}>
															{state}
														</span>
													</div>
													<div className="hint" style={{ fontSize: "0.72rem" }}>
														{lane.state} · {rtt?.toFixed(1) ?? "—"} ms
													</div>
												</div>
												<div title="คะแนนส่งข้อความ" style={{ fontSize: "var(--text-sm)", whiteSpace: "nowrap" }}>
													<span className="hint">SEND </span>
													<span style={{ color: "var(--signal-go)", fontWeight: 700 }}>⭐ {lane.send.stars}</span>{" "}
													<span style={{ color: "#d7b226", fontWeight: 700 }}>🍌 {lane.send.bananas}</span>
													{lane.send.bigStars > 0 ? ` · 🌟 ${lane.send.bigStars}` : ""}
												</div>
												<div title="คะแนนรับ event" style={{ textAlign: "right", fontSize: "var(--text-sm)", whiteSpace: "nowrap" }}>
													<span className="hint">POLL </span>
													<span style={{ color: "var(--signal-go)", fontWeight: 700 }}>⭐ {lane.poll.stars}</span>{" "}
													<span style={{ color: "#d7b226", fontWeight: 700 }}>🍌 {lane.poll.bananas}</span>
													{lane.poll.bigStars > 0 ? ` · 🌟 ${lane.poll.bigStars}` : ` · ${winRate}%`}
												</div>
											</div>
										);
									})}
								</div>
							</CollapsibleSection>
						);
					})
				)}
			</div>

			<div style={{ marginTop: "var(--space-md)", paddingTop: "var(--space-md)", borderTop: "1px solid var(--border-hair)" }}>
				<CollapsibleSection
					title="LANE + LATENCY LOG"
					meta={`${history.length} รายการ`}
					summary={
						<span className="hint" style={{ fontSize: "var(--text-xs)" }}>
							เก็บย้อนหลัง {race.retentionDays || 30} วัน
						</span>
					}
				>
					<div
						style={{
							display: "flex",
							flexDirection: "column",
							gap: 5,
							maxHeight: 440,
							overflowY: "auto",
							paddingRight: 3,
						}}
					>
						{history.length === 0 && <div className="hint">ยังไม่มีเหตุการณ์เลนหรือ latency ให้แสดง</div>}
						{history.map((item, index) => {
							if (item.kind === "lane") {
								const event = item.event;
								return (
									<div key={`lane-${event.ts}-${event.laneId}-${event.role}-${index}`} className="lane-log-row">
										<span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", whiteSpace: "nowrap" }}>
											{historyTime(event.ts)}
										</span>
										<span className="chip chip--idle" style={{ fontSize: "var(--text-xs)" }}>
											{event.role.toUpperCase()}
										</span>
										<span style={{ fontSize: "var(--text-sm)", fontWeight: 700 }}>เลน {event.laneId}</span>
										<span className="hint" style={{ fontSize: "var(--text-xs)", flex: 1 }}>
											{shortOrigin(event.origin)}
										</span>
										<span className={`chip ${event.result === "star" ? "chip--go" : "chip--warn"}`} style={{ fontSize: "var(--text-xs)" }}>
											{event.result === "star" ? "⭐" : "🍌"} RTT {formatMs(event.rttMs)}
										</span>
									</div>
								);
							}
							const sample = item.sample;
							const breakdown = sample.breakdown;
							return (
								<div key={`latency-${sample.ts}-${sample.botId}-${index}`} className="lane-log-row">
									<span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", whiteSpace: "nowrap" }}>
										{historyTime(sample.ts)}
									</span>
									<span className={`chip ${sample.ok ? "chip--go" : "chip--bad"}`} style={{ fontSize: "var(--text-xs)" }}>
										LATENCY
									</span>
									<span style={{ fontSize: "var(--text-sm)", fontWeight: 700 }}>{botNames.get(sample.botId) ?? `Bot ${sample.botId}`}</span>
									<span className="hint" style={{ fontSize: "var(--text-xs)" }}>
										{sample.surface.toUpperCase()} · {sample.source === "auto" ? "AUTO" : "TEST"}
									</span>
									{sample.textPreview && (
										<span
											className="hint"
											title={sample.textPreview}
											style={{
												fontSize: "var(--text-xs)",
												flex: 1,
												minWidth: 120,
												overflow: "hidden",
												textOverflow: "ellipsis",
												whiteSpace: "nowrap",
											}}
										>
											{sample.textPreview}
										</span>
									)}
									{breakdown && (
										<span className="hint mono" style={{ fontSize: "var(--text-xs)", whiteSpace: "nowrap" }}>
											LINE {formatMs(breakdown.lineMs)} · CODE {formatMs(breakdown.codeMs)}
											{breakdown.inboundMs !== undefined ? ` · IN ${formatMs(breakdown.inboundMs)}` : ""}
										</span>
									)}
									<span className={`chip ${sample.ok ? "chip--go" : "chip--bad"}`} style={{ fontSize: "var(--text-xs)" }}>
										TOTAL {formatMs(sample.latencyMs)}
									</span>
								</div>
							);
						})}
					</div>
				</CollapsibleSection>
			</div>
		</section>
	);
}
