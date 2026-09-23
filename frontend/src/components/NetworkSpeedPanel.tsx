import type { LaneStat } from "../lib/types.ts";
import { rttToneClass } from "../lib/lane-tone.ts";
import { groupLanesByWorker, summarizeLaneGroup } from "../lib/group-lanes.ts";
import { CollapsibleSection } from "./CollapsibleSection.tsx";

interface NetworkSpeedPanelProps {
	lanes: LaneStat[];
}

function shortOrigin(origin: string): string {
	try {
		return new URL(origin).hostname;
	} catch {
		return origin;
	}
}

function stateLabel(state: LaneStat["state"]): string {
	if (state === "ready") return "พร้อม";
	if (state === "connecting") return "กำลังต่อ";
	if (state === "draining") return "กำลังปิด";
	return "ตาย";
}

function stateChipClass(state: LaneStat["state"]): string {
	if (state === "ready") return "chip--go";
	if (state === "connecting") return "chip--warn";
	return "chip--bad";
}

export function NetworkSpeedPanel({ lanes }: NetworkSpeedPanelProps) {
	const live = lanes.filter((lane) => lane.state !== "dead");
	const groups = groupLanesByWorker(live);
	const overall = summarizeLaneGroup(live);

	return (
		<section className="panel" style={{ padding: "var(--space-md)" }}>
			<div className="panel-head">
				<div>
					<div className="label">NETWORK · LINE ↔ AKAMAI</div>
					<div style={{ fontWeight: 700, marginTop: 3 }}>ความเร็วเครือข่ายแบบเรียลไทม์</div>
					<p className="hint" style={{ margin: "0.35rem 0 0" }}>
						อุ่นแล้ว = ผ่าน PING และ HEAD /SQ1 แล้ว · “จริง” จะแสดงเมื่อมี send/poll ผ่านเลนนั้น · แต่ละคำขอใช้เลนเดียวเพื่อป้องกันส่งซ้ำ
					</p>
				</div>
				<div className="panel-head-badges">
					{overall.failing > 0 && <span className="chip chip--bad">{overall.failing} มีปัญหา</span>}
					<span className="chip">
						{overall.ready}/{overall.total} พร้อม
					</span>
					{overall.fastestRttMs !== undefined && <span className="chip chip--go mono">เร็วสุด {overall.fastestRttMs.toFixed(1)}ms</span>}
					<span className="chip chip--go">● LIVE</span>
				</div>
			</div>

			<div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: "var(--space-md)" }}>
				{live.length === 0 ? (
					<div className="hint">ยังไม่มี connection ที่ยืนยันสถานะ — รอข้อความหรือ ping รอบแรก</div>
				) : (
					groups.map((group) => {
						const summary = summarizeLaneGroup(group.lanes);
						const hasPreferred = group.lanes.some((lane) => lane.routingPreferred);
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
										{summary.failing > 0 && <span className="chip chip--bad">{summary.failing} มีปัญหา</span>}
										<span className="chip">
											{summary.ready}/{summary.total} พร้อม
										</span>
										{summary.fastestRttMs !== undefined && (
											<span className={`chip mono ${hasPreferred ? "chip--go" : ""}`}>{summary.fastestRttMs.toFixed(1)}ms</span>
										)}
									</>
								}
							>
								<div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
									{group.lanes.map((lane) => {
										const applied = lane.applicationRttMs;
										return (
											<div key={`${lane.workerId}-${lane.origin}-${lane.id}`} className="lane-row">
												<div style={{ minWidth: 0 }}>
													<div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
														เลน {lane.id}
													</div>
													<div className="hint" style={{ fontSize: "0.72rem" }}>
														{lane.inFlight > 0 ? `กำลังส่ง ${lane.inFlight} คำขอ` : "ว่าง"}
														{lane.consecutiveFailures > 0 ? ` · ล้มเหลวติดกัน ${lane.consecutiveFailures} ครั้ง` : ""}
													</div>
												</div>
												<span className={`chip ${stateChipClass(lane.state)}`}>{stateLabel(lane.state)}</span>
												<div className="lane-row-metric" title="PING เปล่า — วัดแค่ connection ไม่รวมงานจริง">
													<span className="hint">PING </span>
													<span className="mono">{lane.rttMs !== undefined ? `${lane.rttMs.toFixed(1)}ms` : "—"}</span>
												</div>
												<div
													className="lane-row-metric"
													style={{ fontWeight: 700 }}
													title={
														applied !== undefined
															? "วัดจากงานจริง (ส่งข้อความ/poll)"
															: lane.lastOkAt > 0
																? "อุ่น connection และ application path แล้ว แต่ยังไม่มี send/poll จริงผ่านเลนนี้"
																: "กำลังรอการอุ่น connection"
													}
												>
													{applied !== undefined ? (
														<span className={`chip ${rttToneClass(true, lane.routingPreferred)} mono`}>จริง {applied.toFixed(1)}ms</span>
													) : (
														<span className="hint">{lane.lastOkAt > 0 ? "อุ่นแล้ว · รองานจริง" : "กำลังอุ่น"}</span>
													)}
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
		</section>
	);
}
