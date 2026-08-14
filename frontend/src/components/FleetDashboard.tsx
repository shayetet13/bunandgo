import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import type { Bot, MetricsSummary } from "../lib/types.ts";
import { StatCard } from "./StatCard.tsx";
import { BucketBarChart } from "./BucketBarChart.tsx";

interface FleetDashboardProps {
	bots: Bot[];
}

type Period = "daily" | "monthly" | "yearly";

const PERIOD_LABEL: Record<Period, string> = {
	daily: "รายวัน",
	monthly: "รายเดือน",
	yearly: "รายปี",
};

const REFRESH_MS = 15_000;

export function FleetDashboard({ bots }: FleetDashboardProps) {
	const [summary, setSummary] = useState<MetricsSummary>();
	const [period, setPeriod] = useState<Period>("daily");

	useEffect(() => {
		let cancelled = false;
		function load() {
			api.metricsSummary()
				.then((s) => {
					if (!cancelled) setSummary(s);
				})
				.catch(() => {});
		}
		load();
		const timer = setInterval(load, REFRESH_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, []);

	const onlineCount = bots.filter((b) => b.status === "online").length;

	return (
		<section className="panel" style={{ padding: "var(--space-md)" }}>
			<div className="label" style={{ marginBottom: "var(--space-sm)" }}>ภาพรวมบอททั้งหมด</div>

			<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "var(--space-md)", marginBottom: "var(--space-md)" }}>
				<StatCard label="จำนวนบอท" value={`${onlineCount}/${bots.length}`} hint="ออนไลน์ / ทั้งหมด" />
				<StatCard label="ข้อความทั้งหมด" value={summary ? String(summary.totalMessages) : "—"} hint="ตั้งแต่เริ่มใช้งาน" />
				<StatCard label="วันนี้" value={summary ? String(summary.todayCount) : "—"} hint="ข้อความที่ส่งวันนี้" />
				<StatCard label="เดือนนี้" value={summary ? String(summary.monthCount) : "—"} hint="ข้อความที่ส่งเดือนนี้" />
				<StatCard label="ปีนี้" value={summary ? String(summary.yearCount) : "—"} hint="ข้อความที่ส่งปีนี้" />
			</div>

			<div style={{ display: "flex", gap: "var(--space-xs)", marginBottom: "var(--space-sm)" }}>
				{(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
					<button
						key={p}
						onClick={() => setPeriod(p)}
						style={{
							background: period === p ? "var(--bg-panel-raised)" : "transparent",
							border: `1px solid ${period === p ? "var(--signal-go-dim)" : "var(--border-hair)"}`,
							color: period === p ? "var(--signal-go)" : "var(--text-secondary)",
							borderRadius: "var(--radius-sm)",
							padding: "0.35rem 0.8rem",
							fontSize: "var(--text-sm)",
							fontWeight: period === p ? 700 : 500,
							cursor: "pointer",
						}}
					>
						{PERIOD_LABEL[p]}
					</button>
				))}
			</div>

			<BucketBarChart buckets={summary?.[period] ?? []} period={period} />
		</section>
	);
}
