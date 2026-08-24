import { useMemo, useState } from "react";
import type { ServerLoadSample } from "../lib/types.ts";
import { MONITORED_SERVERS } from "../lib/monitored-servers.ts";

interface ServerLoadChartProps {
	title: string;
	metric: "cpuPercent" | "memoryPercent";
	samples: ServerLoadSample[];
	rangeHours: number;
}

const WIDTH = 680;
const HEIGHT = 220;
const PLOT_LEFT = 36;
const PLOT_RIGHT = WIDTH - 8;
const PLOT_TOP = 10;
const PLOT_BOTTOM = HEIGHT - 26;
const GRID_STEPS = [0, 25, 50, 75, 100];

function formatAxisTime(ts: number, rangeHours: number): string {
	return new Intl.DateTimeFormat("th-TH", {
		...(rangeHours > 30 ? { day: "2-digit", month: "2-digit" } : {}),
		hour: "2-digit",
		minute: "2-digit",
	}).format(ts);
}

/** Nearest sample to `ts` in a series already sorted ascending by ts, or undefined if empty. */
function nearestSample(series: ServerLoadSample[], ts: number): ServerLoadSample | undefined {
	if (series.length === 0) return undefined;
	let lo = 0;
	let hi = series.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (series[mid]!.ts < ts) lo = mid + 1;
		else hi = mid;
	}
	if (lo > 0 && Math.abs(series[lo - 1]!.ts - ts) < Math.abs(series[lo]!.ts - ts)) return series[lo - 1];
	return series[lo];
}

/** Hand-rolled SVG line chart — CPU% or RAM% for all three servers on one 0-100 axis,
 * fixed categorical color per server, hover crosshair + one shared tooltip. No chart library,
 * matching this project's existing DispatchChart/BucketBarChart approach. */
export function ServerLoadChart({ title, metric, samples, rangeHours }: ServerLoadChartProps) {
	const [hoverFraction, setHoverFraction] = useState<number>();

	const now = Date.now();
	const minTs = now - rangeHours * 3_600_000;

	const seriesByServer = useMemo(() => {
		const map = new Map<string, ServerLoadSample[]>();
		for (const server of MONITORED_SERVERS) {
			map.set(
				server.id,
				samples.filter((s) => s.serverId === server.id && s.ts >= minTs).sort((a, b) => a.ts - b.ts),
			);
		}
		return map;
		// eslint-disable-next-line react-hooks/exhaustive-deps -- `now`/`minTs` intentionally not deps: recomputing every render as the clock moves would fight `samples` identity for no visible benefit within one poll interval.
	}, [samples, rangeHours]);

	const xOf = (ts: number) => PLOT_LEFT + ((ts - minTs) / (now - minTs)) * (PLOT_RIGHT - PLOT_LEFT);
	const yOf = (value: number) => PLOT_BOTTOM - (Math.max(0, Math.min(100, value)) / 100) * (PLOT_BOTTOM - PLOT_TOP);

	const hasAny = [...seriesByServer.values()].some((series) => series.length > 0);
	const hoverTs = hoverFraction === undefined ? undefined : minTs + hoverFraction * (now - minTs);

	return (
		<section className="panel server-chart-card">
			<div className="server-chart-head">
				<span className="server-chart-title">{title}</span>
				<div className="server-chart-legend">
					{MONITORED_SERVERS.map((server) => (
						<span className="server-chart-legend-item" key={server.id}>
							<i style={{ background: server.color }} />
							{server.label}
						</span>
					))}
				</div>
			</div>

			<div
				className="server-chart-plot"
				onPointerMove={(event) => {
					const rect = event.currentTarget.getBoundingClientRect();
					setHoverFraction(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)));
				}}
				onPointerLeave={() => setHoverFraction(undefined)}
			>
				<svg width="100%" height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" style={{ minWidth: 480 }}>
					{GRID_STEPS.map((step) => (
						<g key={step}>
							<line x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={yOf(step)} y2={yOf(step)} stroke="var(--border-hair)" strokeWidth={1} />
							<text x={PLOT_LEFT - 6} y={yOf(step)} textAnchor="end" dominantBaseline="middle" className="server-chart-axis-label">
								{step}%
							</text>
						</g>
					))}

					{MONITORED_SERVERS.map((server) => {
						const series = seriesByServer.get(server.id) ?? [];
						if (series.length === 0) return null;
						if (series.length === 1) {
							const point = series[0]!;
							return (
								<circle
									key={server.id}
									cx={xOf(point.ts)}
									cy={yOf(point[metric])}
									r={4}
									fill={server.color}
									stroke="var(--bg-panel)"
									strokeWidth={2}
								/>
							);
						}
						const path = series.map((s) => `${xOf(s.ts)},${yOf(s[metric])}`).join(" ");
						return (
							<polyline
								key={server.id}
								points={path}
								fill="none"
								stroke={server.color}
								strokeWidth={2}
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						);
					})}

					{hoverTs !== undefined && (
						<line
							x1={xOf(hoverTs)}
							x2={xOf(hoverTs)}
							y1={PLOT_TOP}
							y2={PLOT_BOTTOM}
							stroke="var(--text-dim)"
							strokeWidth={1}
							strokeDasharray="3 3"
						/>
					)}

					<text x={PLOT_LEFT} y={HEIGHT - 8} className="server-chart-axis-label">
						{formatAxisTime(minTs, rangeHours)}
					</text>
					<text x={PLOT_RIGHT} y={HEIGHT - 8} textAnchor="end" className="server-chart-axis-label">
						{formatAxisTime(now, rangeHours)}
					</text>
				</svg>

				{hoverTs !== undefined && (
					<div className="server-chart-tooltip" style={{ left: `${(hoverFraction ?? 0) * 100}%` }}>
						<div className="server-chart-tooltip-time">{formatAxisTime(hoverTs, rangeHours)}</div>
						{MONITORED_SERVERS.map((server) => {
							const point = nearestSample(seriesByServer.get(server.id) ?? [], hoverTs);
							if (!point) return null;
							return (
								<div className="server-chart-tooltip-row" key={server.id}>
									<i style={{ background: server.color }} />
									<span className="server-chart-tooltip-label">{server.label}</span>
									<strong>{point[metric].toFixed(1)}%</strong>
								</div>
							);
						})}
					</div>
				)}

				{!hasAny && <p className="hint server-chart-empty">ยังไม่มีข้อมูลในช่วงเวลาที่เลือก</p>}
			</div>
		</section>
	);
}
