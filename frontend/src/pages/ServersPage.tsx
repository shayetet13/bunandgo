import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import type { HealthStatus, ServerLoadSample, ServerStatus } from "../lib/types.ts";
import { MONITORED_SERVERS, SERVER_LABEL } from "../lib/monitored-servers.ts";
import { ServerLoadChart } from "../components/ServerLoadChart.tsx";

interface ServersPageProps {
	health?: HealthStatus;
	onNotify: (message: string) => void;
}

const RANGE_OPTIONS: ReadonlyArray<{ hours: number; label: string }> = [
	{ hours: 1, label: "1 ชม." },
	{ hours: 6, label: "6 ชม." },
	{ hours: 24, label: "24 ชม." },
	{ hours: 24 * 7, label: "7 วัน" },
];

const MAX_TABLE_ROWS = 200;

function severityColor(capacityPercent: number, exceeded: boolean): string {
	if (exceeded) return "var(--signal-bad)";
	if (capacityPercent >= 70) return "var(--signal-warn)";
	return "var(--signal-go)";
}

function formatTableTime(ts: number): string {
	return new Intl.DateTimeFormat("th-TH", {
		day: "2-digit",
		month: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).format(ts);
}

function ServerCard({ status, color }: { status?: ServerStatus; color: string }) {
	const load = status?.load;
	return (
		<article className="panel server-card">
			<div className="server-card-head">
				<span className="server-card-dot" style={{ background: color }} />
				<div className="server-card-heading">
					<strong>{status?.label ?? "—"}</strong>
					<span className="hint" style={{ margin: 0 }}>
						{status?.role ?? ""}
					</span>
				</div>
				<span className={`chip ${status?.reachable && status.serviceHealthy ? "chip--go" : "chip--bad"}`}>
					{!status ? "ไม่มีข้อมูล" : !status.reachable ? "ติดต่อไม่ได้" : status.serviceHealthy ? "ปกติ" : "มีปัญหา"}
				</span>
			</div>

			{load ? (
				<div className="server-card-meters">
					<div className="server-card-meter">
						<div className="server-card-meter-label">
							<span>CPU</span>
							<span className="mono">{load.cpuPercent.toFixed(1)}%</span>
						</div>
						<div className="server-card-meter-track">
							<div
								className="server-card-meter-fill"
								style={{ width: `${Math.min(100, load.cpuPercent)}%`, background: severityColor(load.capacityPercent, load.exceeded) }}
							/>
						</div>
					</div>
					<div className="server-card-meter">
						<div className="server-card-meter-label">
							<span>RAM</span>
							<span className="mono">{load.memoryPercent.toFixed(1)}%</span>
						</div>
						<div className="server-card-meter-track">
							<div
								className="server-card-meter-fill"
								style={{
									width: `${Math.min(100, load.memoryPercent)}%`,
									background: severityColor(load.capacityPercent, load.exceeded),
								}}
							/>
						</div>
					</div>
				</div>
			) : (
				<p className="hint" style={{ margin: "var(--space-sm) 0 0" }}>
					{status?.detail ?? "ยังไม่มีข้อมูลโหลดของเครื่องนี้"}
				</p>
			)}
		</article>
	);
}

export function ServersPage({ health, onNotify }: ServersPageProps) {
	const [rangeHours, setRangeHours] = useState(24);
	const [samples, setSamples] = useState<ServerLoadSample[]>([]);
	const [loading, setLoading] = useState(true);
	const [showTable, setShowTable] = useState(false);

	useEffect(() => {
		let cancelled = false;
		async function refresh() {
			try {
				const rows = await api.systemLoadHistory(rangeHours);
				if (!cancelled) setSamples(rows);
			} catch (error) {
				if (!cancelled) onNotify(error instanceof Error ? error.message : String(error));
			} finally {
				if (!cancelled) setLoading(false);
			}
		}
		setLoading(true);
		void refresh();
		// Matches the backend recorder's own ~30s cadence — no point polling faster.
		const timer = setInterval(refresh, 30_000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- onNotify is stable from the parent; re-running on it would restart the poll needlessly.
	}, [rangeHours]);

	const statusById = new Map((health?.servers ?? []).map((s) => [s.id, s]));
	const tableRows = [...samples].sort((a, b) => b.ts - a.ts).slice(0, MAX_TABLE_ROWS);

	return (
		<div className="servers-layout">
			<div className="servers-cards">
				{MONITORED_SERVERS.map((server) => (
					<ServerCard key={server.id} status={statusById.get(server.id)} color={server.color} />
				))}
			</div>

			<div className="server-chart-toolbar">
				<div className="server-range-group">
					{RANGE_OPTIONS.map((option) => (
						<button
							key={option.hours}
							className={option.hours === rangeHours ? "primary-button" : "ghost-button"}
							onClick={() => setRangeHours(option.hours)}
						>
							{option.label}
						</button>
					))}
				</div>
				<button className="ghost-button" onClick={() => setShowTable((s) => !s)}>
					{showTable ? "ซ่อนตาราง" : "ดูข้อมูลตาราง"}
				</button>
			</div>

			<ServerLoadChart title="CPU" metric="cpuPercent" samples={samples} rangeHours={rangeHours} />
			<ServerLoadChart title="RAM" metric="memoryPercent" samples={samples} rangeHours={rangeHours} />

			{loading && samples.length === 0 && <p className="hint">กำลังโหลดข้อมูล…</p>}

			{showTable && (
				<section className="panel server-table-card">
					<div className="server-chart-head">
						<span className="server-chart-title">ข้อมูลดิบ</span>
						<span className="hint" style={{ margin: 0 }}>
							{samples.length > MAX_TABLE_ROWS
								? `ล่าสุด ${MAX_TABLE_ROWS} จากทั้งหมด ${samples.length} รายการ`
								: `${samples.length} รายการ`}
						</span>
					</div>
					<div className="server-table-scroll">
						<table className="server-table">
							<thead>
								<tr>
									<th>เวลา</th>
									<th>เซิร์ฟเวอร์</th>
									<th>CPU</th>
									<th>RAM</th>
								</tr>
							</thead>
							<tbody>
								{tableRows.map((row) => (
									<tr key={`${row.serverId}-${row.ts}`}>
										<td className="mono">{formatTableTime(row.ts)}</td>
										<td>{SERVER_LABEL[row.serverId]}</td>
										<td className="mono">{row.cpuPercent.toFixed(1)}%</td>
										<td className="mono">{row.memoryPercent.toFixed(1)}%</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</section>
			)}
		</div>
	);
}
