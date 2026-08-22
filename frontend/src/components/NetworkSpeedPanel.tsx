import type { LaneStat } from "../lib/types.ts";
import { rttToneClass } from "../lib/lane-tone.ts";

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

	return (
		<section className="panel" style={{ padding: "var(--space-md)" }}>
			<div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: "var(--space-md)", flexWrap: "wrap" }}>
				<div>
					<div className="label" style={{ color: "var(--signal-go)" }}>
						NETWORK · LINE ↔ AKAMAI
					</div>
					<div style={{ fontWeight: 700, marginTop: 3 }}>ความเร็วเครือข่ายแบบเรียลไทม์</div>
					<p className="hint" style={{ margin: "0.35rem 0 0" }}>
						พร้อม = connection รอรับงาน ไม่ได้แปลว่ากำลังถูกใช้ · แต่ละคำขอใช้เลนเร็วสุดเพียงเส้นเดียวเพื่อป้องกันส่งซ้ำ
					</p>
				</div>
				<span className="chip chip--go">● LIVE</span>
			</div>

			<div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: "var(--space-md)" }}>
				{live.length === 0 ? (
					<div className="hint">ยังไม่มี connection ที่ยืนยันสถานะ — รอข้อความหรือ ping รอบแรก</div>
				) : (
					live.map((lane) => {
						const applied = lane.applicationRttMs;
						return (
							<div
								key={`${lane.workerId}-${lane.origin}-${lane.id}`}
								style={{
									display: "grid",
									gridTemplateColumns: "minmax(140px, 1fr) auto auto auto",
									gap: "var(--space-sm)",
									alignItems: "center",
									padding: "0.55rem 0.65rem",
									border: "1px solid var(--border-hair)",
									borderRadius: "var(--radius-sm)",
								}}
							>
								<div style={{ minWidth: 0 }}>
									<div style={{ fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
										{shortOrigin(lane.origin)}{" "}
										<span className="hint" style={{ fontWeight: 400 }}>
											· lane {lane.id} · {lane.workerId}
										</span>
									</div>
									<div className="hint" style={{ fontSize: "0.72rem" }}>
										{lane.inFlight > 0 ? `กำลังส่ง ${lane.inFlight} คำขอ` : "ว่าง"}
										{lane.consecutiveFailures > 0 ? ` · ล้มเหลวติดกัน ${lane.consecutiveFailures} ครั้ง` : ""}
									</div>
								</div>
								<span className={`chip ${stateChipClass(lane.state)}`}>{stateLabel(lane.state)}</span>
								<div style={{ textAlign: "right", fontSize: "var(--text-sm)" }} title="PING เปล่า — วัดแค่ connection ไม่รวมงานจริง">
									<span className="hint">PING </span>
									<span className="mono">{lane.rttMs !== undefined ? `${lane.rttMs.toFixed(1)}ms` : "—"}</span>
								</div>
								<div
									style={{ textAlign: "right", fontSize: "var(--text-sm)", fontWeight: 700 }}
									title={applied !== undefined ? "วัดจากงานจริง (ส่งข้อความ/poll)" : "ยังไม่มีงานจริงผ่านเลนนี้"}
								>
									{applied !== undefined ? (
										<span className={`chip ${rttToneClass(true, lane.routingEligible)} mono`}>จริง {applied.toFixed(1)}ms</span>
									) : (
										<span className="hint">ยังไม่มีงานจริง</span>
									)}
								</div>
							</div>
						);
					})
				)}
			</div>
		</section>
	);
}
