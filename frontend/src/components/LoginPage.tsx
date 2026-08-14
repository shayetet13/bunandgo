import { type FormEvent, useState } from "react";
import { api } from "../lib/api.ts";

interface LoginPageProps {
	onLoggedIn: () => void;
}

const inputStyle = {
	background: "var(--bg-inset)",
	border: "1px solid var(--border-hair)",
	borderRadius: "var(--radius-sm)",
	padding: "0.6rem 0.75rem",
	color: "var(--text-primary)",
	fontSize: "var(--text-base)",
	width: "100%",
};

export function LoginPage({ onLoggedIn }: LoginPageProps) {
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);

	async function submit(e: FormEvent) {
		e.preventDefault();
		setError(undefined);
		setLoading(true);
		try {
			await api.login(username, password);
			onLoggedIn();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}

	return (
		<div className="app-shell" style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
			<section
				className="panel"
				style={{
					padding: "var(--space-xl)",
					width: 380,
					maxWidth: "calc(100vw - var(--space-lg) * 2)",
					display: "flex",
					flexDirection: "column",
					gap: "var(--space-md)",
				}}
			>
				<div style={{ textAlign: "center" }}>
					<span
						style={{
							display: "inline-block",
							width: 10,
							height: 10,
							borderRadius: 999,
							background: "var(--accent-line)",
							boxShadow: "0 0 12px var(--accent-line)",
							marginBottom: "var(--space-sm)",
						}}
					/>
					<h1 style={{ margin: 0, fontSize: "1.3rem", letterSpacing: "0.06em", fontWeight: 800 }}>RACE // LINE BOT CONSOLE</h1>
					<p className="hint" style={{ marginTop: "var(--space-xs)" }}>เข้าสู่ระบบเพื่อดูสถานะและข้อความล่าสุดของบอท</p>
				</div>

				<form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
					<div>
						<label className="label" style={{ display: "block", marginBottom: "var(--space-xs)" }}>ชื่อผู้ใช้</label>
						<input
							autoFocus
							value={username}
							onChange={(e) => setUsername(e.target.value)}
							style={inputStyle}
							placeholder="admin"
						/>
					</div>
					<div>
						<label className="label" style={{ display: "block", marginBottom: "var(--space-xs)" }}>รหัสผ่าน</label>
						<input
							type="password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							style={inputStyle}
							placeholder="••••••••"
						/>
					</div>
					<button
						type="submit"
						disabled={loading}
						style={{
							marginTop: "var(--space-xs)",
							background: "var(--signal-go)",
							color: "#04170c",
							border: "none",
							borderRadius: "var(--radius-sm)",
							padding: "0.7rem 1rem",
							fontWeight: 700,
							fontSize: "var(--text-base)",
							cursor: loading ? "default" : "pointer",
							opacity: loading ? 0.6 : 1,
						}}
					>
						{loading ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}
					</button>
				</form>

				{error && (
					<div style={{ color: "var(--signal-bad)", fontSize: "var(--text-sm)", textAlign: "center" }}>{error}</div>
				)}
			</section>
		</div>
	);
}
