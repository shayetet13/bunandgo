interface StatCardProps {
	label: string;
	value: string;
	unit?: string;
	hint: string;
}

export function StatCard({ label, value, unit, hint }: StatCardProps) {
	return (
		<section className="panel" style={{ padding: "var(--space-md)" }}>
			<div className="label" style={{ marginBottom: "var(--space-xs)" }}>{label}</div>
			<div className="mono" style={{ fontSize: "var(--text-stat)", fontWeight: 700 }}>
				{value}
				{unit && <span style={{ fontSize: "0.5em", color: "var(--text-dim)", marginLeft: "0.2em" }}>{unit}</span>}
			</div>
			<p className="hint" style={{ margin: "var(--space-xs) 0 0" }}>{hint}</p>
		</section>
	);
}
