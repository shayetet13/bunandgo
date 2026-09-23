interface ToggleSwitchProps {
	isSelected: boolean;
	onToggle: () => void;
}

export function ToggleSwitch({ isSelected, onToggle }: ToggleSwitchProps) {
	return (
		<button
			type="button"
			aria-pressed={isSelected}
			onClick={onToggle}
			style={{
				display: "flex",
				alignItems: "center",
				width: 44,
				height: 24,
				background: isSelected ? "var(--signal-go-dim)" : "var(--border-hair)",
				border: "1px solid " + (isSelected ? "var(--signal-go-dim)" : "var(--border-hair)"),
				borderRadius: "12px",
				cursor: "pointer",
				position: "relative",
				transition: "all 0.3s ease",
				userSelect: "none",
				padding: 0,
				flexShrink: 0,
			}}
		>
			<span
				style={{
					position: "absolute",
					left: isSelected ? "24px" : "2px",
					width: "20px",
					height: "20px",
					background: "#fff",
					borderRadius: "50%",
					transition: "left 0.3s ease",
					boxShadow: "0 2px 4px rgba(0,0,0,0.2)",
				}}
			/>
		</button>
	);
}
