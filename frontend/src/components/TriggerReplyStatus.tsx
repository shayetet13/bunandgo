import type { LatencyGuardrails, LatencySnapshot } from "../lib/types.ts";

const LEVEL_META: Record<LatencyGuardrails["level"], { tone: "go" | "warn" | "bad"; label: string }> = {
	normal: { tone: "go", label: "ปกติ" },
	warning: { tone: "warn", label: "เริ่มช้า" },
	incident: { tone: "bad", label: "ล่าช้า" },
	severe: { tone: "bad", label: "รุนแรง" },
	critical: { tone: "bad", label: "วิกฤต" },
};

interface TriggerReplyStatusProps {
	snapshot: LatencySnapshot;
	/**
	 * lineCreatedTime - triggerCreatedTime for the latest sample carrying
	 * both — LINE's own stamp at each end, so this is the true trigger-to-reply
	 * time, not an approximation built from our own clock. Undefined until a
	 * sample with both stamps has arrived (see latestTriggerReplyMs).
	 */
	liveMs?: number;
}

export function TriggerReplyStatus({ snapshot, liveMs }: TriggerReplyStatusProps) {
	const { guardrails } = snapshot;
	const hasData = snapshot.count > 0;
	const meta = LEVEL_META[guardrails.level];
	const hasLast = liveMs !== undefined;

	return (
		<section className="panel" style={{ padding: "var(--space-md)" }}>
			<div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--space-md)", flexWrap: "wrap" }}>
				<div>
					<div className="label">LINE TRIGGER → REPLY</div>
					<div style={{ fontWeight: 700 }}>สถานะความเร็วตอบกลับ</div>
				</div>
				<span className={`chip chip--${hasData ? meta.tone : "idle"}`}>
					<span className="chip-dot" />
					{hasData ? meta.label : "ยังไม่มีข้อมูล"}
				</span>
			</div>

			{/* The live number: this reply's own round trip, painted the instant
			    send_result arrives over the socket — not a percentile over a
			    window, so a single slow reply shows up here before it could
			    ever move P95. */}
			<div style={{ margin: "var(--space-md) 0 0" }}>
				<div className="label" style={{ marginBottom: "0.2rem" }}>
					ล่าสุด (real-time)
				</div>
				<div className="mono" style={{ fontWeight: 800, fontSize: "2.4rem", lineHeight: 1, color: hasLast ? "var(--text-primary)" : undefined }}>
					{hasLast ? Math.round(liveMs!) : "—"}
					{hasLast && <span style={{ fontSize: "0.4em", color: "var(--text-dim)", marginLeft: "0.25em" }}>ms</span>}
				</div>
			</div>

			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
					gap: "var(--space-sm)",
					margin: "var(--space-md) 0 0",
				}}
			>
				<Metric label="P50" value={hasData ? `${Math.round(snapshot.p50)} ms` : "—"} />
				<Metric label="P95" value={hasData ? `${Math.round(snapshot.p95)} ms` : "—"} />
				<Metric label="P99" value={hasData ? `${Math.round(snapshot.p99)} ms` : "—"} />
				<Metric
					label={`ภายใน ${guardrails.thresholdsMs.target}ms`}
					value={
						hasData && guardrails.rateReliable
							? `${Math.round(guardrails.targetRate)}% (n=${guardrails.rateSampleCount})`
							: hasData
								? `สะสมข้อมูล (n=${guardrails.rateSampleCount})`
								: "—"
					}
				/>
			</div>

			{hasData && (
				<p className="hint" style={{ margin: "var(--space-sm) 0 0" }}>
					เกิน {guardrails.thresholdsMs.p95Limit}ms: {guardrails.over50} ครั้ง · เกิน {guardrails.thresholdsMs.incident}ms:{" "}
					{guardrails.over80} ครั้ง · เกิน {guardrails.thresholdsMs.critical}ms: {guardrails.over100} ครั้ง (จาก {snapshot.count} ครั้งล่าสุด)
				</p>
			)}
		</section>
	);
}

function Metric({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<div className="label" style={{ marginBottom: "0.2rem" }}>
				{label}
			</div>
			<div className="mono" style={{ fontWeight: 700, fontSize: "var(--text-stat)" }}>
				{value}
			</div>
		</div>
	);
}
