import type { UserRole } from "../lib/types.ts";

interface SettingsPageProps {
	username: string;
	role: UserRole;
	onLogout: () => void;
}

function Row({ label, value }: { label: string; value: string }) {
	return (
		<div style={{ display: "flex", justifyContent: "space-between", padding: "0.6rem 0", borderTop: "1px solid var(--border-hair)" }}>
			<span style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>{label}</span>
			<span style={{ fontSize: "var(--text-sm)", fontWeight: 700 }}>{value}</span>
		</div>
	);
}

export function SettingsPage({ username, role, onLogout }: SettingsPageProps) {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: "var(--space-md)", }}>
			<section className="panel" style={{ padding: "var(--space-md)" }}>
				<div className="label" style={{ marginBottom: "var(--space-sm)" }}>บัญชีผู้ใช้งาน</div>
				<Row label="ชื่อผู้ใช้" value={username || "—"} />
				<Row label="สิทธิ์การใช้งาน" value={role === "admin" ? "ผู้ดูแลระบบ" : "ผู้ใช้งาน"} />
				<Row label="Device profile เริ่มต้นของบอทใหม่" value="DESKTOPWIN" />
				{role === "admin" && <p className="hint" style={{ marginTop: "var(--space-sm)" }}>บัญชี admin หลักกำหนดได้จาก <code className="mono">ADMIN_USERNAME</code> / <code className="mono">ADMIN_PASSWORD</code></p>}
			</section>

			<section className="panel" style={{ padding: "var(--space-md)" }}>
				<div className="label" style={{ marginBottom: "var(--space-sm)" }}>เซสชัน</div>
				<p className="hint" style={{ margin: "0 0 var(--space-sm)" }}>
					เซสชันถูกเก็บอย่างปลอดภัยและใช้งานต่อได้หลังรีสตาร์ท จนกว่าจะออกจากระบบหรือ admin หยุดบัญชี
				</p>
				<button
					onClick={onLogout}
					style={{ background: "transparent", border: "1px solid var(--signal-bad-dim)", color: "var(--signal-bad)", borderRadius: "var(--radius-sm)", padding: "0.5rem 1rem", cursor: "pointer", fontWeight: 700 }}
				>
					ออกจากระบบ
				</button>
			</section>
		</div>
	);
}
