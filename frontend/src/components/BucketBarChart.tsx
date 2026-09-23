import type { BucketCount } from "../lib/types.ts";

const THAI_MONTHS_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

function formatLabel(bucket: string, period: "daily" | "monthly" | "yearly"): string {
	if (period === "yearly") return bucket;
	if (period === "monthly") {
		const [year, month] = bucket.split("-");
		const monthIdx = Number(month) - 1;
		return `${THAI_MONTHS_SHORT[monthIdx] ?? month}${year ? ` ${year}` : ""}`;
	}
	// daily: "YYYY-MM-DD" -> "D ก.ค."
	const [, month, day] = bucket.split("-");
	const monthIdx = Number(month) - 1;
	return `${Number(day)} ${THAI_MONTHS_SHORT[monthIdx] ?? month}`;
}

interface BucketBarChartProps {
	buckets: BucketCount[];
	period: "daily" | "monthly" | "yearly";
}

/** Real per-bucket message counts from the backend — no synthetic data. */
export function BucketBarChart({ buckets, period }: BucketBarChartProps) {
	if (buckets.length === 0) {
		return (
			<p className="hint" style={{ textAlign: "center", padding: "var(--space-md) 0" }}>
				ยังไม่มีข้อมูลในช่วงนี้
			</p>
		);
	}
	const max = Math.max(...buckets.map((b) => b.count), 1);

	return (
		<div style={{ display: "flex", alignItems: "flex-end", gap: "6px", height: 140, overflowX: "auto", paddingBottom: "var(--space-xs)" }}>
			{buckets.map((b) => (
				<div
					key={b.bucket}
					style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "4px", minWidth: 40, flexShrink: 0 }}
				>
					<span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)" }}>
						{b.count}
					</span>
					<div
						style={{
							width: 20,
							height: Math.max(4, (b.count / max) * 90),
							background: b.count > 0 ? "var(--signal-go)" : "var(--border-hair)",
							opacity: b.count > 0 ? 0.85 : 0.5,
							borderRadius: 2,
						}}
					/>
					<span className="hint" style={{ fontSize: "0.625rem", margin: 0, whiteSpace: "nowrap" }}>
						{formatLabel(b.bucket, period)}
					</span>
				</div>
			))}
		</div>
	);
}
