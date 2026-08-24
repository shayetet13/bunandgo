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
	const [busy, setBusy] = useState(false);

	const [editingId, setEditingId] = useState<number>();
	const [editTitle, setEditTitle] = useState("");
	const [editBody, setEditBody] = useState("");
	const [editBusy, setEditBusy] = useState(false);

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
			await api.createAnnouncement({ title: title.trim(), body: body.trim() });
			setTitle("");
			setBody("");
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
	}

	function cancelEdit() {
		setEditingId(undefined);
	}

	async function submitEdit(event: FormEvent, id: number) {
		event.preventDefault();
		setEditBusy(true);
		try {
			await api.updateAnnouncement(id, { title: editTitle.trim(), body: editBody.trim() });
			setEditingId(undefined);
			await refresh();
		} catch (error) {
			onNotify(error instanceof Error ? error.message : String(error));
		} finally {
			setEditBusy(false);
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
							<article className="announce-card" key={item.id}>
								<div className="announce-card-main">
									<strong>{item.title}</strong>
									<p className="hint" style={{ margin: "0.3rem 0 0", whiteSpace: "pre-wrap" }}>
										{item.body}
									</p>
									<div className="hint" style={{ margin: "0.4rem 0 0", fontSize: "var(--text-xs)" }}>
										แก้ไขล่าสุด {formattedAt(item.updatedAt)}
									</div>
								</div>
								<div className="announce-card-actions">
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
