import { type CSSProperties, type FormEvent, useEffect, useState } from "react";
import type { ChatRow, ScheduledPost, Surface } from "../lib/types.ts";
import { previewReplyText } from "../lib/text-preview.ts";
import { bangkokInputToEpochMs, epochMsToBangkokInput, formatBangkokDateTime } from "../lib/bangkok-time.ts";
import {
	isScheduledPostRunAtValid,
	isScheduledPostToggleable,
	SCHEDULED_POST_STATUS_LABEL,
	scheduledPostStatusOf,
} from "../lib/scheduled-post-status.ts";

interface ScheduledPostEditorProps {
	chats: ChatRow[];
	posts: ScheduledPost[];
	onCreate: (input: Omit<ScheduledPost, "id" | "botId" | "sentAt">) => void;
	onUpdate: (post: ScheduledPost) => void;
	onToggle: (post: ScheduledPost) => void;
	onDelete: (id: number) => void;
}

const inputStyle: CSSProperties = {
	background: "var(--bg-inset)",
	border: "1px solid var(--border-hair)",
	borderRadius: "var(--radius-sm)",
	padding: "0.45rem 0.6rem",
	color: "var(--text-primary)",
	fontSize: "var(--text-sm)",
};

const textareaStyle: CSSProperties = {
	...inputStyle,
	fontFamily: "inherit",
	resize: "vertical",
	minHeight: "2.3rem",
	lineHeight: 1.4,
};

interface Draft {
	surface: Surface;
	targetMid: string;
	text: string;
	runAtInput: string;
}

function emptyDraft(chats: ChatRow[]): Draft {
	const first = chats[0];
	return { surface: first?.surface ?? "talk", targetMid: first?.mid ?? "", text: "", runAtInput: "" };
}

const STATUS_LABEL = SCHEDULED_POST_STATUS_LABEL;

const STATUS_COLOR: Record<ReturnType<typeof scheduledPostStatusOf>, string> = {
	sent: "var(--signal-go)",
	missed: "var(--signal-bad)",
	disabledByUser: "var(--text-secondary)",
	processing: "var(--accent-line)",
	pending: "var(--accent-line)",
};

export function ScheduledPostEditor({ chats, posts, onCreate, onUpdate, onToggle, onDelete }: ScheduledPostEditorProps) {
	const [draft, setDraft] = useState<Draft>(() => emptyDraft(chats));
	const [editingId, setEditingId] = useState<number | null>(null);
	const [editDraft, setEditDraft] = useState<Draft | null>(null);
	const [error, setError] = useState<string | undefined>();

	// The `chats` prop changes when the parent switches which bot is
	// selected — an in-progress draft's targetMid can otherwise keep
	// pointing at a room belonging to the *previous* bot, which submits
	// silently to the wrong bot/room since only the id is validated, not
	// which bot it actually belongs to. Message text and the chosen time
	// are left alone; only the now-invalid target (and its surface) reset.
	// Any in-progress edit is abandoned outright — the row it was editing
	// belongs to the bot being switched away from.
	useEffect(() => {
		setDraft((prev) => {
			if (chats.some((c) => c.mid === prev.targetMid && c.surface === prev.surface)) return prev;
			const first = chats[0];
			return { ...prev, surface: first?.surface ?? prev.surface, targetMid: first?.mid ?? "" };
		});
		setEditingId(null);
		setEditDraft(null);
	}, [chats]);

	function chatsFor(surface: Surface): ChatRow[] {
		return chats.filter((c) => c.surface === surface);
	}

	function buildInput(d: Draft): Omit<ScheduledPost, "id" | "botId" | "sentAt"> | undefined {
		const runAt = bangkokInputToEpochMs(d.runAtInput);
		if (runAt === undefined || !d.targetMid.trim() || !d.text.trim()) return undefined;
		return { surface: d.surface, targetMid: d.targetMid.trim(), text: d.text, runAt, enabled: true };
	}

	function submit(e: FormEvent) {
		e.preventDefault();
		setError(undefined);
		const input = buildInput(draft);
		if (!input) {
			setError("กรอกห้องแชท ข้อความ และวันเวลาให้ครบ");
			return;
		}
		if (!isScheduledPostRunAtValid(input.runAt)) {
			setError("เวลาที่ตั้งต้องอยู่ในอนาคต");
			return;
		}
		onCreate(input);
		setDraft(emptyDraft(chats));
	}

	function startEdit(post: ScheduledPost) {
		setEditingId(post.id);
		setEditDraft({ surface: post.surface, targetMid: post.targetMid, text: post.text, runAtInput: epochMsToBangkokInput(post.runAt) });
	}

	function cancelEdit() {
		setEditingId(null);
		setEditDraft(null);
	}

	function saveEdit(post: ScheduledPost) {
		if (!editDraft) return;
		const input = buildInput(editDraft);
		if (!input) return;
		onUpdate({ ...post, ...input });
		cancelEdit();
	}

	return (
		<section className="panel" style={{ padding: "var(--space-md)" }}>
			<div className="label" style={{ marginBottom: "var(--space-xs)" }}>
				โพสตามเวลา (ไม่ใช้ keyword) · {posts.length}
			</div>
			<p className="hint" style={{ margin: "0 0 var(--space-sm)" }}>
				ตั้งวัน เดือน ปี และเวลา (เวลาไทย) ละเอียดถึงมิลลิวินาที — เช่น 14:00:00.000 — พอถึงเวลาที่ตั้งเป๊ะ
				บอทจะยิงข้อความที่เตรียมไว้ทันทีโดยไม่ต้องรอ keyword ใดๆ และไม่มีการหน่วงเพิ่มใดๆ ในระบบก่อนส่ง (ส่งเร็วกว่าเวลาที่ตั้งไม่ได้
				แต่จะไม่ช้ากว่านั้นเกินกว่าที่ตัวเครื่อง/เครือข่ายจะจำกัดไว้)
			</p>

			<form onSubmit={submit} style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-xs)", marginBottom: "var(--space-sm)" }}>
				<select
					value={draft.surface}
					onChange={(e) => {
						const surface = e.target.value as Surface;
						setDraft({ ...draft, surface, targetMid: chatsFor(surface)[0]?.mid ?? "" });
					}}
					style={inputStyle}
				>
					<option value="talk">กลุ่มแชท (talk)</option>
					<option value="square">OpenChat (square)</option>
				</select>
				<select
					value={draft.targetMid}
					onChange={(e) => setDraft({ ...draft, targetMid: e.target.value })}
					style={{ ...inputStyle, flex: "1 1 160px" }}
				>
					<option value="" disabled>
						— เลือกห้องแชท —
					</option>
					{chatsFor(draft.surface).map((chat) => (
						<option key={chat.mid} value={chat.mid}>
							{chat.name ?? chat.mid}
						</option>
					))}
				</select>
				<input
					type="datetime-local"
					step="0.001"
					value={draft.runAtInput}
					onChange={(e) => setDraft({ ...draft, runAtInput: e.target.value })}
					style={inputStyle}
					title="วันและเวลา ละเอียดถึงมิลลิวินาที (เวลาไทย / Asia/Bangkok) — เช่น 14:00:00.000"
				/>
				<textarea
					placeholder="ข้อความที่จะโพสเมื่อถึงเวลา"
					value={draft.text}
					onChange={(e) => setDraft({ ...draft, text: e.target.value })}
					rows={2}
					style={{ ...textareaStyle, flex: "1 1 160px" }}
				/>
				<button
					type="submit"
					style={{
						background: "var(--signal-go)",
						color: "#04170c",
						border: "none",
						borderRadius: "var(--radius-sm)",
						padding: "0.45rem 0.9rem",
						fontWeight: 700,
						cursor: "pointer",
					}}
				>
					ตั้งเวลา
				</button>
			</form>
			{error && <p style={{ margin: "0 0 var(--space-sm)", fontSize: "var(--text-sm)", color: "var(--signal-bad)" }}>{error}</p>}

			<div style={{ display: "flex", flexDirection: "column", gap: "var(--space-xs)", maxHeight: 320, overflowY: "auto" }}>
				{posts.length === 0 && (
					<p className="hint" style={{ margin: 0 }}>
						ยังไม่มีรายการโพสตามเวลา
					</p>
				)}
				{posts.map((post) => {
					const chat = chats.find((c) => c.mid === post.targetMid);
					const status = scheduledPostStatusOf(post);
					return editingId === post.id && editDraft ? (
						<div
							key={post.id}
							style={{
								display: "flex",
								flexWrap: "wrap",
								alignItems: "center",
								gap: "var(--space-xs)",
								background: "var(--bg-inset)",
								border: "1px solid var(--signal-go-dim)",
								borderRadius: "var(--radius-sm)",
								padding: "0.45rem 0.6rem",
							}}
						>
							<select
								value={editDraft.surface}
								onChange={(e) => {
									const surface = e.target.value as Surface;
									setEditDraft({ ...editDraft, surface, targetMid: chatsFor(surface)[0]?.mid ?? "" });
								}}
								style={inputStyle}
							>
								<option value="talk">กลุ่มแชท (talk)</option>
								<option value="square">OpenChat (square)</option>
							</select>
							<select
								value={editDraft.targetMid}
								onChange={(e) => setEditDraft({ ...editDraft, targetMid: e.target.value })}
								style={{ ...inputStyle, flex: "1 1 140px" }}
							>
								<option value="" disabled>
									— เลือกห้องแชท —
								</option>
								{chatsFor(editDraft.surface).map((c) => (
									<option key={c.mid} value={c.mid}>
										{c.name ?? c.mid}
									</option>
								))}
							</select>
							<input
								type="datetime-local"
								step="0.001"
								value={editDraft.runAtInput}
								onChange={(e) => setEditDraft({ ...editDraft, runAtInput: e.target.value })}
								style={inputStyle}
								title="วันและเวลา ละเอียดถึงมิลลิวินาที (เวลาไทย / Asia/Bangkok)"
							/>
							<textarea
								value={editDraft.text}
								onChange={(e) => setEditDraft({ ...editDraft, text: e.target.value })}
								rows={2}
								style={{ ...textareaStyle, flex: "1 1 140px" }}
							/>
							<button onClick={() => saveEdit(post)} style={saveBtnStyle}>
								บันทึก
							</button>
							<button onClick={cancelEdit} style={deleteBtnStyle}>
								ยกเลิก
							</button>
						</div>
					) : (
						<div
							key={post.id}
							style={{
								display: "flex",
								alignItems: "center",
								gap: "var(--space-sm)",
								background: "var(--bg-inset)",
								border: "1px solid var(--border-hair)",
								borderRadius: "var(--radius-sm)",
								padding: "0.45rem 0.6rem",
								opacity: status === "sent" || status === "missed" ? 0.6 : 1,
							}}
						>
							<span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", minWidth: 150 }}>
								{formatBangkokDateTime(post.runAt)}
							</span>
							<span style={{ fontSize: "var(--text-xs)", fontWeight: 700, color: STATUS_COLOR[status], minWidth: 90 }}>
								{STATUS_LABEL[status]}
							</span>
							<span style={{ fontSize: "var(--text-sm)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
								<span className="mono">
									{post.surface} · {chat?.name ?? post.targetMid}
								</span>{" "}
								→ {previewReplyText(post.text)}
							</span>
							{isScheduledPostToggleable(status) && (
								<button onClick={() => onToggle(post)} style={toggleBtnStyle(post.enabled)}>
									{post.enabled ? "ปิดใช้งาน" : "เปิดใช้งาน"}
								</button>
							)}
							<button onClick={() => startEdit(post)} style={editBtnStyle}>
								แก้ไข
							</button>
							<button onClick={() => onDelete(post.id)} style={deleteBtnStyle}>
								✕
							</button>
						</div>
					);
				})}
			</div>
		</section>
	);
}

function toggleBtnStyle(enabled: boolean): CSSProperties {
	return {
		border: `1px solid ${enabled ? "var(--signal-go-dim)" : "var(--border-strong)"}`,
		color: enabled ? "var(--signal-go)" : "var(--text-secondary)",
		background: enabled ? "transparent" : "var(--bg-panel-raised)",
		borderRadius: "var(--radius-sm)",
		fontSize: "var(--text-xs)",
		fontWeight: 700,
		padding: "0.2rem 0.5rem",
		cursor: "pointer",
	};
}

const deleteBtnStyle: CSSProperties = {
	border: "1px solid var(--border-strong)",
	color: "var(--text-secondary)",
	background: "var(--bg-panel-raised)",
	borderRadius: "var(--radius-sm)",
	padding: "0.2rem 0.5rem",
	cursor: "pointer",
};

const editBtnStyle: CSSProperties = {
	border: "1px solid var(--border-strong)",
	color: "var(--text-primary)",
	background: "transparent",
	borderRadius: "var(--radius-sm)",
	fontSize: "var(--text-xs)",
	fontWeight: 700,
	padding: "0.2rem 0.5rem",
	cursor: "pointer",
};

const saveBtnStyle: CSSProperties = {
	border: "none",
	color: "#04170c",
	background: "var(--signal-go)",
	borderRadius: "var(--radius-sm)",
	fontSize: "var(--text-xs)",
	fontWeight: 700,
	padding: "0.2rem 0.6rem",
	cursor: "pointer",
};
