import { useState } from "react";
import { api } from "../lib/api.ts";
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
	const [restartState, setRestartState] = useState<"idle" | "requesting" | "waiting" | "ready" | "error">("idle");
	const [restartMessage, setRestartMessage] = useState("");

	async function waitForWorker(): Promise<boolean> {
		const deadline = Date.now() + 90_000;
		await new Promise((resolve) => setTimeout(resolve, 4_000));
		while (Date.now() < deadline) {
			try {
				const health = await api.health();
				if (health.uptimeSeconds < 45) return true;
			} catch {
				// The API being briefly unreachable is expected during restart.
			}
			await new Promise((resolve) => setTimeout(resolve, 2_000));
		}
		return false;
	}

	async function handleRestartWorker() {
		if (!window.confirm("รีสตาร์ท linebot-worker ตอนนี้? บอทใน worker หลักจะหยุดชั่วคราวและกลับมาออนไลน์อัตโนมัติ")) return;
		setRestartState("requesting");
		setRestartMessage("กำลังส่งคำขอรีสตาร์ท…");
		try {
			await api.restartWorker();
			setRestartState("waiting");
			setRestartMessage("รับคำขอแล้ว กำลังรอ worker กลับมาออนไลน์…");
			if (await waitForWorker()) {
				setRestartState("ready");
				setRestartMessage("linebot-worker กลับมาออนไลน์แล้ว");
			} else {
				setRestartState("error");
				setRestartMessage("ยังตรวจไม่พบว่า worker กลับมาออนไลน์ภายใน 90 วินาที กรุณาตรวจหน้า Overview");
			}
		} catch (error) {
			setRestartState("error");
			setRestartMessage(error instanceof Error ? error.message : "สั่งรีสตาร์ทไม่สำเร็จ");
		}
	}

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

			{role === "admin" && (
				<section className="panel" style={{ padding: "var(--space-md)" }}>
					<div className="label" style={{ marginBottom: "var(--space-sm)" }}>ควบคุมระบบ</div>
					<p className="hint" style={{ margin: "0 0 var(--space-sm)" }}>
						รีสตาร์ทเฉพาะ <code className="mono">linebot-worker</code> บน Server 2 โดยไม่กระทบ shard worker
						เซสชันและสถานะบอทจะถูกกู้คืนอัตโนมัติหลังระบบกลับมา
					</p>
					<button
						onClick={() => void handleRestartWorker()}
						disabled={restartState === "requesting" || restartState === "waiting"}
						style={{ background: "transparent", border: "1px solid var(--signal-warn)", color: "var(--signal-warn)", borderRadius: "var(--radius-sm)", padding: "0.5rem 1rem", cursor: restartState === "requesting" || restartState === "waiting" ? "wait" : "pointer", fontWeight: 700, opacity: restartState === "requesting" || restartState === "waiting" ? 0.6 : 1 }}
					>
						{restartState === "requesting" || restartState === "waiting" ? "กำลังรีสตาร์ท…" : "Restart linebot-worker"}
					</button>
					{restartMessage && (
						<p className="hint" style={{ margin: "var(--space-sm) 0 0", color: restartState === "error" ? "var(--signal-bad)" : restartState === "ready" ? "var(--signal-go)" : undefined }}>
							{restartMessage}
						</p>
					)}
				</section>
			)}
		</div>
	);
}
