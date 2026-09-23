import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import type { Announcement } from "../lib/types.ts";

interface AnnouncementsPageProps {
	onNotify: (message: string) => void;
}

function formattedAt(timestamp: number): string {
	return new Intl.DateTimeFormat("th-TH", {
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(timestamp);
}

/**
 * Admin-only CRUD for the notices shown at the top of every user's console
 * (in place of the old "ผู้บรรยายสนาม" race commentary). One shared list —
 * every announcement created here is visible to every user, no per-user
 * targeting or draft/publish state.
 */
export function AnnouncementsPage({ onNotify }: AnnouncementsPageProps) {
	const [announcements, setAnnouncements] = useState<Announcement[]>([]);
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [isModalAlert, setIsModalAlert] = useState(false);
	const [isPinned, setIsPinned] = useState(false);
	const [busy, setBusy] = useState(false);

	const [editingId, setEditingId] = useState<number>();
	const [editTitle, setEditTitle] = useState("");
	const [editBody, setEditBody] = useState("");
	const [editIsModalAlert, setEditIsModalAlert] = useState(false);
	const [editIsPinned, setEditIsPinned] = useState(false);
	const [editBusy, setEditBusy] = useState(false);

	const [pinBusyId, setPinBusyId] = useState<number>();

	const [confirmDeleteId, setConfirmDeleteId] = useState<number>();

	const refresh = useCallback(async () => {
		try {
			setAnnouncements(await api.listAnnouncements());
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
			await api.createAnnouncement({ title: title.trim(), body: body.trim(), isModalAlert, isPinned });
			setTitle("");
			setBody("");
			setIsModalAlert(false);
			setIsPinned(false);
			await refresh();
		} catch (error) {
			onNotify(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}

	function startEdit(item: Announcement) {
		setEditingId(item.id);
		setEditTitle(item.title);
		setEditBody(item.body);
		setEditIsModalAlert(item.isModalAlert);
		setEditIsPinned(item.isPinned);
	}

	function cancelEdit() {
		setEditingId(undefined);
	}

	async function submitEdit(event: FormEvent, id: number) {
		event.preventDefault();
		setEditBusy(true);
		try {
			await api.updateAnnouncement(id, {
				title: editTitle.trim(),
				body: editBody.trim(),
				isModalAlert: editIsModalAlert,
				isPinned: editIsPinned,
			});
			setEditingId(undefined);
			await refresh();
		} catch (error) {
			onNotify(error instanceof Error ? error.message : String(error));
		} finally {
			setEditBusy(false);
		}
	}

	async function togglePin(item: Announcement) {
		setPinBusyId(item.id);
		try {
			await api.updateAnnouncement(item.id, {
				title: item.title,
				body: item.body,
				isModalAlert: item.isModalAlert,
				isPinned: !item.isPinned,
			});
			await refresh();
		} catch (error) {
			onNotify(error instanceof Error ? error.message : String(error));
		} finally {
			setPinBusyId(undefined);
		}
	}

	async function remove(id: number) {
		try {
			await api.deleteAnnouncement(id);
			setConfirmDeleteId(undefined);
			await refresh();
		} catch (error) {
			onNotify(error instanceof Error ? error.message : String(error));
		}
	}

	return (
		<div className="announce-layout">
			<section className="panel announce-create-card">
				<div>
					<div className="label" style={{ color: "var(--signal-warn)" }}>
						เพิ่มประกาศ
					</div>
					<h2 style={{ margin: "0.3rem 0 0", fontSize: "1.35rem" }}>แจ้งข่าวสารถึงผู้ใช้ทุกคน</h2>
					<p className="hint" style={{ margin: "0.4rem 0 0" }}>
						ข้อความจะขึ้นแสดงที่หน้าคอนโซลของผู้ใช้ทุกคนทันที
					</p>
				</div>
				<form className="announce-create-form" onSubmit={submit}>
					<label>
						<span className="label">หัวข้อ</span>
						<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="เช่น ปิดปรับปรุงระบบ" required />
					</label>
					<label>
						<span className="label">เนื้อหา</span>
						<textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="รายละเอียดประกาศ" rows={4} required />
					</label>
					<label className="announce-modal-checkbox">
						<input type="checkbox" checked={isModalAlert} onChange={(event) => setIsModalAlert(event.target.checked)} />
						<span>
							แสดงเป็น <strong>modal แจ้งเตือนสำคัญ</strong> — เด้งขึ้นกลางจอทันทีที่เข้าระบบ (ใช้กับข่าวสำคัญที่ต้องรู้เท่านั้น)
						</span>
					</label>
					<label className="announce-modal-checkbox">
						<input type="checkbox" checked={isPinned} onChange={(event) => setIsPinned(event.target.checked)} />
						<span>
							<strong>ปักหมุด</strong> — อยู่บนสุดของรายการเสมอ ไม่ว่าจะมีประกาศใหม่กว่าเข้ามากี่อัน
						</span>
					</label>
					<button className="primary-button" type="submit" disabled={busy}>
						{busy ? "กำลังเพิ่ม…" : "+ เพิ่มประกาศ"}
					</button>
				</form>
			</section>

			<section className="panel announce-list-card">
				<div className="announce-list-heading">
					<div>
						<div className="label">ประกาศทั้งหมด</div>
						<div style={{ marginTop: "0.25rem", color: "var(--text-secondary)" }}>{announcements.length} รายการ</div>
					</div>
					<button className="ghost-button" onClick={() => void refresh()}>
						รีเฟรช
					</button>
				</div>
				<div className="announce-cards">
					{announcements.length === 0 && (
						<div style={{ color: "var(--text-dim)", fontSize: "var(--text-sm)", textAlign: "center", padding: "1rem" }}>ยังไม่มีประกาศ</div>
					)}
					{announcements.map((item) =>
						editingId === item.id ? (
							<form className="announce-card announce-edit-form" key={item.id} onSubmit={(event) => void submitEdit(event, item.id)}>
								<label>
									<span className="label">หัวข้อ</span>
									<input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} required />
								</label>
								<label>
									<span className="label">เนื้อหา</span>
									<textarea value={editBody} onChange={(event) => setEditBody(event.target.value)} rows={4} required />
								</label>
								<label className="announce-modal-checkbox">
									<input
										type="checkbox"
										checked={editIsModalAlert}
										onChange={(event) => setEditIsModalAlert(event.target.checked)}
									/>
									<span>
										แสดงเป็น <strong>modal แจ้งเตือนสำคัญ</strong>
									</span>
								</label>
								<label className="announce-modal-checkbox">
									<input type="checkbox" checked={editIsPinned} onChange={(event) => setEditIsPinned(event.target.checked)} />
									<span>
										<strong>ปักหมุด</strong>
									</span>
								</label>
								<div className="announce-card-actions">
									<button className="primary-button" type="submit" disabled={editBusy}>
										{editBusy ? "กำลังบันทึก…" : "บันทึก"}
									</button>
									<button className="ghost-button" type="button" onClick={cancelEdit}>
										ยกเลิก
									</button>
								</div>
							</form>
						) : (
							<article className="announce-card" key={item.id} data-pinned={item.isPinned}>
								<div className="announce-card-main">
									<div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
										{item.isPinned && (
											<span aria-label="ปักหมุดอยู่" title="ปักหมุดอยู่">
												📌
											</span>
										)}
										<strong>{item.title}</strong>
										{item.isModalAlert && <span className="chip chip--warn">modal แจ้งเตือนสำคัญ</span>}
									</div>
									<p className="hint" style={{ margin: "0.3rem 0 0", whiteSpace: "pre-wrap" }}>
										{item.body}
									</p>
									<div className="hint" style={{ margin: "0.4rem 0 0", fontSize: "var(--text-xs)" }}>
										แก้ไขล่าสุด {formattedAt(item.updatedAt)}
									</div>
								</div>
								<div className="announce-card-actions">
									<button className="ghost-button" onClick={() => void togglePin(item)} disabled={pinBusyId === item.id}>
										{item.isPinned ? "เลิกปักหมุด" : "ปักหมุด"}
									</button>
									<button className="ghost-button" onClick={() => startEdit(item)}>
										แก้ไข
									</button>
									{confirmDeleteId === item.id ? (
										<>
											<button className="danger-button" onClick={() => void remove(item.id)}>
												ยืนยันลบ
											</button>
											<button className="ghost-button" onClick={() => setConfirmDeleteId(undefined)}>
												ยกเลิก
											</button>
										</>
									) : (
										<button className="danger-button" onClick={() => setConfirmDeleteId(item.id)}>
											ลบ
										</button>
									)}
								</div>
							</article>
						),
					)}
				</div>
			</section>
		</div>
	);
}
