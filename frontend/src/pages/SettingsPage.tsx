import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import type { UserRole } from "../lib/types.ts";
import { ToggleSwitch } from "../components/ToggleSwitch.tsx";

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
	const [currentPassword, setCurrentPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [passwordState, setPasswordState] = useState<"idle" | "saving" | "done" | "error">("idle");
	const [passwordMessage, setPasswordMessage] = useState("");
	const [maintenanceMode, setMaintenanceModeState] = useState(false);
	const [maintenanceSaving, setMaintenanceSaving] = useState(false);
	const [maintenanceError, setMaintenanceError] = useState<string>();

	useEffect(() => {
		if (role !== "admin") return;
		api
			.getMaintenanceMode()
			.then((r) => setMaintenanceModeState(r.enabled))
			.catch(() => {
				// Leave the default (off) — the toggle itself is the retry.
			});
	}, [role]);

	async function handleToggleMaintenanceMode() {
		const next = !maintenanceMode;
		setMaintenanceSaving(true);
		setMaintenanceError(undefined);
		try {
			await api.setMaintenanceMode(next);
			setMaintenanceModeState(next);
		} catch (error) {
			setMaintenanceError(error instanceof Error ? error.message : "บันทึกไม่สำเร็จ");
		} finally {
			setMaintenanceSaving(false);
		}
	}

	async function handleChangePassword(event: React.FormEvent) {
		event.preventDefault();
		if (newPassword !== confirmPassword) {
			setPasswordState("error");
			setPasswordMessage("ยืนยันรหัสผ่านใหม่ไม่ตรงกัน");
			return;
		}
		setPasswordState("saving");
		setPasswordMessage("กำลังเปลี่ยนรหัสผ่าน…");
		try {
			await api.changePassword(currentPassword, newPassword);
			setCurrentPassword("");
			setNewPassword("");
			setConfirmPassword("");
			setPasswordState("done");
			setPasswordMessage("เปลี่ยนรหัสผ่านแล้ว และออกจากระบบอุปกรณ์อื่นทั้งหมดเรียบร้อย");
		} catch (error) {
			setPasswordState("error");
			setPasswordMessage(error instanceof Error ? error.message : "เปลี่ยนรหัสผ่านไม่สำเร็จ");
		}
	}

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
		<div style={{ display: "flex", flexDirection: "column", gap: "var(--space-md)" }}>
			<section className="panel" style={{ padding: "var(--space-md)" }}>
				<div className="label" style={{ marginBottom: "var(--space-sm)" }}>
					บัญชีผู้ใช้งาน
				</div>
				<Row label="ชื่อผู้ใช้" value={username || "—"} />
				<Row label="สิทธิ์การใช้งาน" value={role === "admin" ? "ผู้ดูแลระบบ" : "ผู้ใช้งาน"} />
				<Row label="Device profile เริ่มต้นของบอทใหม่" value="DESKTOPWIN" />
				{role === "admin" && (
					<p className="hint" style={{ marginTop: "var(--space-sm)" }}>
						บัญชี admin หลักกำหนดได้จาก <code className="mono">ADMIN_USERNAME</code> / <code className="mono">ADMIN_PASSWORD</code>
					</p>
				)}
			</section>

			<section className="panel" style={{ padding: "var(--space-md)" }}>
				<div className="label" style={{ marginBottom: "var(--space-sm)" }}>
					เซสชัน
				</div>
				<p className="hint" style={{ margin: "0 0 var(--space-sm)" }}>
					Admin หมดอายุเมื่อไม่ใช้งาน 30 นาทีและไม่เกิน 12 ชั่วโมง ส่วนผู้ใช้ทั่วไปไม่เกิน 7 วัน
				</p>
				<button
					onClick={onLogout}
					style={{
						background: "transparent",
						border: "1px solid var(--signal-bad-dim)",
						color: "var(--signal-bad)",
						borderRadius: "var(--radius-sm)",
						padding: "0.5rem 1rem",
						cursor: "pointer",
						fontWeight: 700,
					}}
				>
					ออกจากระบบ
				</button>
			</section>

			<section className="panel" style={{ padding: "var(--space-md)" }}>
				<div className="label" style={{ marginBottom: "var(--space-sm)" }}>
					เปลี่ยนรหัสผ่าน
				</div>
				<form onSubmit={(event) => void handleChangePassword(event)} style={{ display: "grid", gap: "var(--space-sm)", maxWidth: 480 }}>
					<input
						type="password"
						autoComplete="current-password"
						value={currentPassword}
						onChange={(event) => setCurrentPassword(event.target.value)}
						placeholder="รหัสผ่านปัจจุบัน"
						required
						maxLength={200}
					/>
					<input
						type="password"
						autoComplete="new-password"
						value={newPassword}
						onChange={(event) => setNewPassword(event.target.value)}
						placeholder="รหัสผ่านใหม่ (อย่างน้อย 12 ตัว)"
						required
						minLength={12}
						maxLength={200}
					/>
					<input
						type="password"
						autoComplete="new-password"
						value={confirmPassword}
						onChange={(event) => setConfirmPassword(event.target.value)}
						placeholder="ยืนยันรหัสผ่านใหม่"
						required
						minLength={12}
						maxLength={200}
					/>
					<button
						type="submit"
						disabled={passwordState === "saving"}
						style={{
							justifySelf: "start",
							background: "transparent",
							border: "1px solid var(--border-strong)",
							color: "var(--text-primary)",
							borderRadius: "var(--radius-sm)",
							padding: "0.5rem 1rem",
							cursor: passwordState === "saving" ? "wait" : "pointer",
							fontWeight: 700,
						}}
					>
						{passwordState === "saving" ? "กำลังบันทึก…" : "เปลี่ยนรหัสผ่าน"}
					</button>
				</form>
				{passwordMessage && (
					<p
						className="hint"
						style={{
							margin: "var(--space-sm) 0 0",
							color: passwordState === "error" ? "var(--signal-bad)" : passwordState === "done" ? "var(--signal-go)" : undefined,
						}}
					>
						{passwordMessage}
					</p>
				)}
			</section>

			{role === "admin" && (
				<section className="panel" style={{ padding: "var(--space-md)" }}>
					<div className="label" style={{ marginBottom: "var(--space-sm)" }}>
						ควบคุมระบบ
					</div>
					<p className="hint" style={{ margin: "0 0 var(--space-sm)" }}>
						รีสตาร์ทเฉพาะ <code className="mono">linebot-worker</code> บน Server 2
						เซสชันและสถานะบอทจะถูกกู้คืนอัตโนมัติหลังระบบกลับมา
					</p>
					<button
						onClick={() => void handleRestartWorker()}
						disabled={restartState === "requesting" || restartState === "waiting"}
						style={{
							background: "transparent",
							border: "1px solid var(--signal-warn)",
							color: "var(--signal-warn)",
							borderRadius: "var(--radius-sm)",
							padding: "0.5rem 1rem",
							cursor: restartState === "requesting" || restartState === "waiting" ? "wait" : "pointer",
							fontWeight: 700,
							opacity: restartState === "requesting" || restartState === "waiting" ? 0.6 : 1,
						}}
					>
						{restartState === "requesting" || restartState === "waiting" ? "กำลังรีสตาร์ท…" : "Restart linebot-worker"}
					</button>
					{restartMessage && (
						<p
							className="hint"
							style={{
								margin: "var(--space-sm) 0 0",
								color: restartState === "error" ? "var(--signal-bad)" : restartState === "ready" ? "var(--signal-go)" : undefined,
							}}
						>
							{restartMessage}
						</p>
					)}
				</section>
			)}

			{role === "admin" && (
				<section className="panel" style={{ padding: "var(--space-md)" }}>
					<div className="label" style={{ marginBottom: "var(--space-sm)" }}>
						โหมดปิดปรับปรุง
					</div>
					<p className="hint" style={{ margin: "0 0 var(--space-sm)" }}>
						เมื่อเปิดใช้ ผู้ใช้งานทั่วไป (ไม่ใช่ admin) จะเห็นข้อความ "ตอนนี้ระบบปิดปรับปรุง" แทนหน้าจัดการบอททั้งหมด
						บอทของทุกคนยังทำงานตอบข้อความตามปกติ ไม่ถูกกระทบ — และหน้า Settings นี้ยังเข้าได้เสมอเพื่อปิดโหมดคืน
					</p>
					<div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)" }}>
						<ToggleSwitch isSelected={maintenanceMode} onToggle={() => void handleToggleMaintenanceMode()} />
						<span style={{ fontSize: "var(--text-sm)", fontWeight: 700 }}>
							{maintenanceSaving
								? "กำลังบันทึก…"
								: maintenanceMode
									? "เปิดอยู่ — ผู้ใช้งานเห็นหน้าปิดปรับปรุง"
									: "ปิดอยู่ — ผู้ใช้งานใช้งานได้ตามปกติ"}
						</span>
					</div>
					{maintenanceError && (
						<p className="hint" style={{ margin: "var(--space-sm) 0 0", color: "var(--signal-bad)" }}>
							{maintenanceError}
						</p>
					)}
				</section>
			)}
		</div>
	);
}
