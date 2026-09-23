import type { LatencySample } from "../lib/types.ts";

interface DispatchChartProps {
	samples: LatencySample[];
	rangeMinutes?: number;
}

/** Real per-minute dispatch counts bucketed from latency-sample history — no synthetic data. */
export function DispatchChart({ samples, rangeMinutes = 60 }: DispatchChartProps) {
	const now = Date.now();
	const bucketMs = 60_000;
	const buckets = new Array(rangeMinutes).fill(0) as number[];

	for (const s of samples) {
		const diff = now - s.ts;
		if (diff < 0 || diff > rangeMinutes * bucketMs) continue;
		const idx = rangeMinutes - 1 - Math.floor(diff / bucketMs);
		if (idx >= 0 && idx < rangeMinutes) buckets[idx]!++;
	}

	const max = Math.max(...buckets, 1);
	const width = 640;
	const height = 160;
	const gap = 2;
	const barWidth = width / rangeMinutes - gap;
	const hasAny = buckets.some((c) => c > 0);

	return (
		<div style={{ width: "100%", overflowX: "auto" }}>
			<svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ minWidth: 480 }}>
				{buckets.map((count, i) => {
					const h = (count / max) * (height - 12);
					return (
						<rect
							key={i}
							x={i * (barWidth + gap)}
							y={height - h}
							width={Math.max(barWidth, 1)}
							height={Math.max(h, 1)}
							rx="1"
							fill={count > 0 ? "var(--signal-go)" : "var(--border-hair)"}
							opacity={count > 0 ? 0.85 : 0.5}
						/>
					);
				})}
			</svg>
			{!hasAny && (
				<p className="hint" style={{ margin: "var(--space-xs) 0 0", textAlign: "center" }}>
					ยังไม่มีข้อมูลการส่งในช่วง {rangeMinutes} นาทีล่าสุด
				</p>
			)}
		</div>
	);
}
