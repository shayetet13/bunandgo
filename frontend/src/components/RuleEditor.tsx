import { type CSSProperties, type FormEvent, useState } from "react";
import type { Rule } from "../lib/types.ts";
import { previewReplyText } from "../lib/text-preview.ts";

interface RuleEditorProps {
	rules: Rule[];
	onCreate: (input: Omit<Rule, "id" | "botId">) => void;
	onToggle: (rule: Rule) => void;
	onUpdate: (rule: Rule) => void;
	onDelete: (id: number) => void;
}

const inputStyle = {
	background: "var(--bg-inset)",
	border: "1px solid var(--border-hair)",
	borderRadius: "var(--radius-sm)",
	padding: "0.45rem 0.6rem",
	color: "var(--text-primary)",
	fontSize: "var(--text-sm)",
};

const replyTextareaStyle: CSSProperties = {
	...inputStyle,
	fontFamily: "inherit",
	resize: "vertical",
	minHeight: "2.3rem",
	lineHeight: 1.4,
};

const matchValuePlaceholder: Record<Rule["matchType"], string> = {
	equals: "ข้อความที่ต้องตรงทั้งหมด",
	startsWith: "ข้อความที่ต้องขึ้นต้นด้วย",
	regex: "regex pattern",
	containsAny: "คำค้นหา คั่นด้วย , เช่น 14,15,16,test,car",
};

interface EditDraft {
	surface: Rule["surface"];
	matchType: Rule["matchType"];
	matchValue: string;
	replyText: string;
}

export function RuleEditor({ rules, onCreate, onToggle, onUpdate, onDelete }: RuleEditorProps) {
	const [matchType, setMatchType] = useState<Rule["matchType"]>("equals");
	const [surface, setSurface] = useState<Rule["surface"]>("all");
	const [matchValue, setMatchValue] = useState("");
	const [replyText, setReplyText] = useState("");

	const [editingId, setEditingId] = useState<number | null>(null);
	const [editDraft, setEditDraft] = useState<EditDraft | null>(null);

	function submit(e: FormEvent) {
		e.preventDefault();
		if (!matchValue.trim() || !replyText.trim()) return;
		onCreate({ surface, matchType, matchValue, replyText, enabled: true, priority: 0 });
		setMatchValue("");
		setReplyText("");
	}

	function startEdit(rule: Rule) {
		setEditingId(rule.id);
		setEditDraft({ surface: rule.surface, matchType: rule.matchType, matchValue: rule.matchValue, replyText: rule.replyText });
	}

	function cancelEdit() {
		setEditingId(null);
		setEditDraft(null);
	}

	function saveEdit(rule: Rule) {
		if (!editDraft || !editDraft.matchValue.trim() || !editDraft.replyText.trim()) return;
		onUpdate({ ...rule, ...editDraft });
		cancelEdit();
	}

	return (
		<section className="panel" style={{ padding: "var(--space-md)" }}>
			<div className="label" style={{ marginBottom: "var(--space-xs)" }}>
				กฎการตอบ · {rules.length}
			</div>
			<p className="hint" style={{ margin: "0 0 var(--space-sm)" }}>
				ตั้งเงื่อนไข เมื่อข้อความตรงกฎที่เปิดอยู่ (เรียงจากบนลงล่าง) บอทจะตอบกลับทันที
			</p>

			<form className="rule-form" onSubmit={submit} style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-xs)", marginBottom: "var(--space-md)" }}>
				<select value={surface} onChange={(e) => setSurface(e.target.value as Rule["surface"])} style={inputStyle}>
					<option value="all">ทุกประเภท (all)</option>
					<option value="talk">กลุ่มแชท (talk)</option>
					<option value="square">OpenChat (square)</option>
				</select>
				<select value={matchType} onChange={(e) => setMatchType(e.target.value as Rule["matchType"])} style={inputStyle}>
					<option value="equals">ตรงทั้งหมด (equals)</option>
					<option value="startsWith">ขึ้นต้นด้วย (startsWith)</option>
					<option value="containsAny">มีคำใดคำหนึ่ง (คั่นด้วย ,)</option>
					<option value="regex">regex (ขั้นสูง)</option>
				</select>
				<input
					placeholder={matchValuePlaceholder[matchType]}
					value={matchValue}
					onChange={(e) => setMatchValue(e.target.value)}
					style={{ ...inputStyle, flex: "1 1 120px" }}
				/>
				<textarea
					placeholder="ข้อความตอบกลับ (กด Enter เพื่อขึ้นบรรทัดใหม่)"
					value={replyText}
					onChange={(e) => setReplyText(e.target.value)}
					rows={2}
					style={{ ...replyTextareaStyle, flex: "1 1 120px" }}
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
					เพิ่ม
				</button>
			</form>

			<div style={{ display: "flex", flexDirection: "column", gap: "var(--space-xs)", maxHeight: 260, overflowY: "auto" }}>
				{rules.map((rule) =>
					editingId === rule.id && editDraft ? (
						<div
							className="rule-row"
							key={rule.id}
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
								onChange={(e) => setEditDraft({ ...editDraft, surface: e.target.value as Rule["surface"] })}
								style={inputStyle}
							>
								<option value="all">ทุกประเภท (all)</option>
								<option value="talk">กลุ่มแชท (talk)</option>
								<option value="square">OpenChat (square)</option>
							</select>
							<select
								value={editDraft.matchType}
								onChange={(e) => setEditDraft({ ...editDraft, matchType: e.target.value as Rule["matchType"] })}
								style={inputStyle}
							>
								<option value="equals">ตรงทั้งหมด (equals)</option>
								<option value="startsWith">ขึ้นต้นด้วย (startsWith)</option>
								<option value="containsAny">มีคำใดคำหนึ่ง (คั่นด้วย ,)</option>
								<option value="regex">regex (ขั้นสูง)</option>
							</select>
							<input
								placeholder={matchValuePlaceholder[editDraft.matchType]}
								value={editDraft.matchValue}
								onChange={(e) => setEditDraft({ ...editDraft, matchValue: e.target.value })}
								style={{ ...inputStyle, flex: "1 1 120px" }}
							/>
							<textarea
								placeholder="ข้อความตอบกลับ (กด Enter เพื่อขึ้นบรรทัดใหม่)"
								value={editDraft.replyText}
								onChange={(e) => setEditDraft({ ...editDraft, replyText: e.target.value })}
								rows={2}
								style={{ ...replyTextareaStyle, flex: "1 1 120px" }}
							/>
							<button onClick={() => saveEdit(rule)} style={saveBtnStyle}>
								บันทึก
							</button>
							<button onClick={cancelEdit} style={deleteBtnStyle}>
								ยกเลิก
							</button>
						</div>
					) : (
						<div
							className="rule-row"
							key={rule.id}
							style={{
								display: "flex",
								alignItems: "center",
								gap: "var(--space-sm)",
								background: "var(--bg-inset)",
								border: "1px solid var(--border-hair)",
								borderRadius: "var(--radius-sm)",
								padding: "0.45rem 0.6rem",
								opacity: rule.enabled ? 1 : 0.45,
							}}
						>
							<span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", minWidth: 108 }}>{rule.surface} · {rule.matchType}</span>
							<span style={{ fontSize: "var(--text-sm)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
								<span className="mono">{rule.matchValue}</span> → {previewReplyText(rule.replyText)}
							</span>
							<button onClick={() => onToggle(rule)} style={toggleBtnStyle(rule.enabled)}>
								{rule.enabled ? "ปิดใช้งาน" : "เปิดใช้งาน"}
							</button>
							<button onClick={() => startEdit(rule)} style={editBtnStyle}>
								แก้ไข
							</button>
							<button onClick={() => onDelete(rule.id)} style={deleteBtnStyle}>
								✕
							</button>
						</div>
					)
				)}
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
