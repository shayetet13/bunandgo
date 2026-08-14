import type { LatencySample } from "../lib/types.ts";
import { formatMs as ms } from "../lib/format-ms.ts";
import { sumLatencyBreakdown } from "../lib/live-feed-metrics.ts";

export function LatencyBreakdown({ sample }: { sample?: LatencySample }) {
	const b = sample?.breakdown;
	if (!sample || !b) {
		return (
			<section className="panel" style={{ padding: "var(--space-md)" }}>
				<div className="label" style={{ color: "var(--signal-go)" }}>LATENCY BREAKDOWN</div>
				<p className="hint">ส่งข้อความรอบใหม่เพื่อดูว่าเวลาใช้ไปกับ LINE และโค้ดส่วนใดบ้าง</p>
			</section>
		);
	}

	const measured = sumLatencyBreakdown(b);
	const total = Math.max(measured.totalMs, 0.0001);
	const linePercent = Math.min(100, Math.max(0, (b.lineMs / total) * 100));
	const codePercent = Math.max(0, 100 - linePercent);
	const rows = [
		["เตรียม Protocol / E2EE / Thrift", b.protocolPrepMs],
		["Transport + อ่าน/แปลง response", b.relayAndParseMs],
		["Go เตรียม upstream request", b.goPrepMs],
		["เข้ารหัส relay frame", b.relayEncodeMs],
		["Limiter", b.limiterMs],
		["จับคู่ Rule", b.matchMs],
		["ถอดรหัสข้อความเข้า", b.decryptMs],
	] as const;

	return (
		<section className="panel" style={{ padding: "var(--space-md)" }}>
			<div style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-md)", flexWrap: "wrap" }}>
				<div>
					<div className="label" style={{ color: "var(--signal-go)" }}>LATENCY BREAKDOWN · ล่าสุด</div>
					<div style={{ fontWeight: 700 }}>{sample.surface.toUpperCase()} · {sample.source === "auto" ? "ตอบอัตโนมัติ" : "ทดสอบ"}</div>
				</div>
				<div style={{ display: "flex", gap: "var(--space-lg)", flexWrap: "wrap" }}>
					{/* Spent before any of the numbers beside it start counting:
					    a fast reply that was handed its trigger late still loses
					    the race, and nothing else on this panel would show it. */}
					{b.inboundMs !== undefined && (
						<Metric label="LINE→เรา" value={ms(b.inboundMs)} tone="line" />
					)}
					<Metric label="TOTAL (Σ จริง)" value={ms(measured.totalMs)} />
					<Metric label="LINE" value={ms(b.lineMs)} tone="line" />
					<Metric label="CODE (ผลรวมย่อย)" value={ms(measured.codeMs)} tone="code" />
					<Metric label="LINE CALLS" value={String(b.upstreamCalls)} />
				</div>
			</div>

			<div style={{ display: "flex", height: 12, overflow: "hidden", borderRadius: 999, background: "var(--bg-inset)", margin: "var(--space-md) 0" }}>
				<div title={`LINE ${ms(b.lineMs)}`} style={{ width: `${linePercent}%`, background: "var(--signal-warn)" }} />
				<div title={`CODE ${ms(b.codeMs)}`} style={{ width: `${codePercent}%`, background: "var(--signal-go)" }} />
			</div>

			<p className="hint mono" style={{ margin: "0 0 var(--space-sm)" }}>
				TOTAL = LINE + decrypt + match + limiter + protocol + relay encode + Go + transport/parse
			</p>

			<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "var(--space-xs) var(--space-lg)" }}>
				{rows.map(([label, value]) => (
					<div key={label} style={{ display: "flex", justifyContent: "space-between", gap: "var(--space-sm)", padding: "0.4rem 0", borderBottom: "1px solid var(--border-hair)" }}>
						<span className="hint">{label}</span>
						<span className="mono" style={{ fontWeight: 700 }}>{ms(value)}</span>
					</div>
				))}
			</div>
		</section>
	);
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "line" | "code" }) {
	const color = tone === "line" ? "var(--signal-warn)" : tone === "code" ? "var(--signal-go)" : "var(--text-primary)";
	return (
		<div>
			<div className="label">{label}</div>
			<div className="mono" style={{ fontSize: "var(--text-stat)", fontWeight: 700, color }}>{value}</div>
		</div>
	);
}
