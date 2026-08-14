interface RadarVisualProps {
	activeCount: number;
}

const DOTS = [
	{ cx: 110, cy: 26, duration: "2s" },
	{ cx: 188, cy: 140, duration: "2.4s" },
	{ cx: 42, cy: 152, duration: "1.8s" },
];

/** Decorative — not a literal per-bot map, just reflects whether anything is active. */
export function RadarVisual({ activeCount }: RadarVisualProps) {
	const color = activeCount > 0 ? "var(--signal-go)" : "var(--text-dim)";
	return (
		<div style={{ position: "relative", width: 220, height: 220, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
			<svg width="220" height="220" viewBox="0 0 220 220">
				<circle cx="110" cy="110" r="100" stroke="var(--border-hair)" strokeWidth="1" fill="none" />
				<circle cx="110" cy="110" r="70" stroke="var(--border-hair)" strokeWidth="1" fill="none" />
				<circle cx="110" cy="110" r="40" stroke="var(--signal-go-dim)" strokeWidth="1" fill="none" />
				{activeCount > 0 &&
					DOTS.map((dot, i) => (
						<circle
							key={i}
							cx={dot.cx}
							cy={dot.cy}
							r="4"
							fill="var(--signal-go)"
							style={{ animation: `pulse-dot ${dot.duration} ease-in-out infinite` }}
						/>
					))}
			</svg>
			<div style={{ position: "absolute", textAlign: "center" }}>
				<div className="label">ACTIVE</div>
				<div className="mono" style={{ fontSize: "2.5rem", fontWeight: 800, color, lineHeight: 1.1 }}>{activeCount}</div>
				<div className="label">BOTS ONLINE</div>
			</div>
		</div>
	);
}
