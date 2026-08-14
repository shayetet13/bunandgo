import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { MAX_BOT_QUOTA, type ManagedUser, type QuotaPreview } from "../lib/types.ts";
import { QuotaConfirmModal } from "../components/QuotaConfirmModal.tsx";

interface UsersPageProps {
	onNotify: (message: string) => void;
}

export function UsersPage({ onNotify }: UsersPageProps) {
	const [users, setUsers] = useState<ManagedUser[]>([]);
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [confirmDeleteId, setConfirmDeleteId] = useState<number>();
	const [query, setQuery] = useState("");
	const [pending, setPending] = useState<{ user: ManagedUser; preview: QuotaPreview }>();
	const [quotaBusy, setQuotaBusy] = useState(false);
	const [botPrice, setBotPrice] = useState(100);

	useEffect(() => {
		void api.me().then((me) => setBotPrice(me.botPricePerMonthThb)).catch(() => {});
	}, []);

	const normalizedQuery = query.trim().toLowerCase();
	const visibleUsers = users.filter((user) => !normalizedQuery || user.username.toLowerCase().includes(normalizedQuery));

	const refresh = useCallback(async () => {
		try {
			setUsers(await api.listUsers());
		} catch (error) {
			onNotify(error instanceof Error ? error.message : String(error));
		}
	}, [onNotify]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	async function submit(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		try {
			await api.createUser(username, password);
			setUsername("");
			setPassword("");
			await refresh();
		} catch (error) {
			onNotify(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}

	async function toggle(user: ManagedUser) {
		try {
			await api.setUserActive(user.id, !user.active);
			await refresh();
		} catch (error) {
			onNotify(error instanceof Error ? error.message : String(error));
		}
	}

	// Nothing is sent until the modal is accepted — the dropdown only asks.
	async function askQuota(user: ManagedUser, botQuota: number) {
		if (botQuota === user.botQuota) return;
		try {
			setPending({ user, preview: await api.previewUserBotQuota(user.id, botQuota) });
		} catch (error) {
			onNotify(error instanceof Error ? error.message : String(error));
		}
	}

	async function confirmQuota() {
		if (!pending) return;
		setQuotaBusy(true);
		try {
			const updated = await api.setUserBotQuota(pending.user.id, pending.preview.nextQuota);
			const stopped = updated.stoppedBots ?? [];
			onNotify(
				stopped.length > 0
					? `ตั้งโควตา ${pending.user.username} เป็น ${pending.preview.nextQuota} ตัว · ปิดบอทแล้ว ${stopped.length} ตัว (${stopped.map((bot) => bot.name).join(", ")})`
					: `ตั้งโควตา ${pending.user.username} เป็น ${pending.preview.nextQuota} ตัวแล้ว`,
			);
			setPending(undefined);
			await refresh();
		} catch (error) {
			onNotify(error instanceof Error ? error.message : String(error));
		} finally {
			setQuotaBusy(false);
		}
	}

	async function remove(user: ManagedUser) {
		try {
			await api.deleteUser(user.id);
			setConfirmDeleteId(undefined);
			await refresh();
		} catch (error) {
			onNotify(error instanceof Error ? error.message : String(error));
		}
	}

	return (
		<div className="users-layout">
			{pending && (
				<QuotaConfirmModal
					username={pending.user.username}
					preview={pending.preview}
					pricePerMonthThb={botPrice}
					busy={quotaBusy}
					onConfirm={() => void confirmQuota()}
					onCancel={() => setPending(undefined)}
				/>
			)}
			<section className="panel user-create-card">
				<div>
					<div className="label" style={{ color: "var(--signal-go)" }}>เพิ่มผู้ใช้งาน</div>
					<h2 style={{ margin: "0.3rem 0 0", fontSize: "1.35rem" }}>สร้างพื้นที่บอทส่วนตัว</h2>
					<p className="hint" style={{ margin: "0.4rem 0 0" }}>ผู้ใช้แต่ละคนจะเห็นและจัดการเฉพาะบอทของตัวเอง</p>
				</div>
				<form className="user-create-form" onSubmit={submit}>
					<label>
						<span className="label">ชื่อผู้ใช้</span>
						<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" placeholder="เช่น somchai" required />
					</label>
					<label>
						<span className="label">รหัสผ่านเริ่มต้น</span>
						<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="new-password" placeholder="อย่างน้อย 6 ตัว" required />
					</label>
					<button className="primary-button" type="submit" disabled={busy}>{busy ? "กำลังสร้าง…" : "+ สร้างผู้ใช้"}</button>
				</form>
			</section>

			<section className="panel user-list-card">
				<div className="user-list-heading">
					<div>
						<div className="label">บัญชีทั้งหมด</div>
						<div style={{ marginTop: "0.25rem", color: "var(--text-secondary)" }}>
							{normalizedQuery ? `${visibleUsers.length} / ${users.length} บัญชี` : `${users.length} บัญชี`}
						</div>
					</div>
					<button className="ghost-button" onClick={() => void refresh()}>รีเฟรช</button>
				</div>
				<div className="chat-search-box" style={{ margin: "0 0 var(--space-sm)" }}>
					<span aria-hidden="true">⌕</span>
					<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ค้นหาชื่อผู้ใช้..." />
				</div>
				<div className="user-cards">
					{visibleUsers.length === 0 && (
						<div style={{ color: "var(--text-dim)", fontSize: "var(--text-sm)", textAlign: "center", padding: "1rem" }}>
							{users.length === 0 ? "ยังไม่มีผู้ใช้งาน" : "ไม่พบผู้ใช้ที่ค้นหา"}
						</div>
					)}
					{visibleUsers.map((user) => (
						<article className="user-card" key={user.id}>
							<div className="user-avatar">{user.username.slice(0, 2).toUpperCase()}</div>
							<div className="user-card-main">
								<div className="user-name-line">
									<strong>{user.username}</strong>
									<span className={`chip ${user.active ? "chip--go" : "chip--idle"}`}>{user.active ? "ใช้งาน" : "หยุดอยู่"}</span>
								</div>
								<div className="hint" style={{ margin: 0 }}>
									{user.role === "admin"
										? "ผู้ดูแลระบบ"
										: `ผู้ใช้งาน · ${user.botCount}/${user.botQuota} บอท`}
								</div>
								{user.role !== "admin" && (
									<label style={{ display: "flex", alignItems: "center", gap: "var(--space-xs)", marginTop: "var(--space-xs)" }}>
										<span className="label" style={{ margin: 0 }}>โควตาบอท</span>
										<select
											value={user.botQuota}
											onChange={(event) => void askQuota(user, Number(event.target.value))}
											style={{
												background: "var(--bg-inset)",
												border: "1px solid var(--border-hair)",
												borderRadius: "var(--radius-sm)",
												color: "var(--text-primary)",
												fontSize: "var(--text-xs)",
												padding: "0.2rem 0.4rem",
											}}
										>
											{Array.from({ length: MAX_BOT_QUOTA }, (_unused, index) => index + 1).map((quota) => (
												<option key={quota} value={quota}>{quota} ตัว</option>
											))}
										</select>
										{/* Only reachable if the count changed under a quota set
										    earlier — lowering now stops the excess on the spot. */}
										{user.botCount > user.botQuota && (
											<span className="chip chip--idle">ปิดไว้ {user.botCount - user.botQuota} ตัว (เกินโควตา)</span>
										)}
									</label>
								)}
							</div>
							{user.role !== "admin" && (
								<div className="user-actions">
									<button className="ghost-button" onClick={() => void toggle(user)}>{user.active ? "หยุด" : "เปิดใช้งาน"}</button>
									{confirmDeleteId === user.id ? (
										<>
											<button className="danger-button" onClick={() => void remove(user)}>ยืนยันลบ</button>
											<button className="ghost-button" onClick={() => setConfirmDeleteId(undefined)}>ยกเลิก</button>
										</>
									) : (
										<button className="danger-button" onClick={() => setConfirmDeleteId(user.id)}>ลบ</button>
									)}
								</div>
							)}
						</article>
					))}
				</div>
			</section>
		</div>
	);
}
