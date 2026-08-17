import { type CSSProperties, type FormEvent, useState } from "react";
import type { Rule } from "../lib/types.ts";
import { previewReplyText } from "../lib/text-preview.ts";
import { RULE_MATCH_GUIDES, ruleMatchFeedback, validateRuleMatchValue } from "../lib/rule-input.ts";

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
	const [createError, setCreateError] = useState<string>();

	const [editingId, setEditingId] = useState<number | null>(null);
	const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
	const [editError, setEditError] = useState<string>();
	const createFeedback = ruleMatchFeedback(matchType, matchValue);
	const editFeedback = editDraft ? ruleMatchFeedback(editDraft.matchType, editDraft.matchValue) : undefined;
	const createDisplayedError = createFeedback?.valid === false ? createFeedback.message : createError;
	const editDisplayedError = editFeedback?.valid === false ? editFeedback.message : editError;

	function submit(e: FormEvent) {
		e.preventDefault();
		const keyError = validateRuleMatchValue(matchType, matchValue);
		if (keyError) {
			setCreateError(keyError);
			return;
		}
		if (!replyText.trim()) {
			setCreateError("กรุณากรอกข้อความที่ต้องการให้บอทตอบกลับ");
			return;
		}
		setCreateError(undefined);
		onCreate({ surface, matchType, matchValue, replyText, enabled: true, priority: 0 });
		setMatchValue("");
		setReplyText("");
	}

	function startEdit(rule: Rule) {
		setEditingId(rule.id);
		setEditDraft({ surface: rule.surface, matchType: rule.matchType, matchValue: rule.matchValue, replyText: rule.replyText });
		setEditError(undefined);
	}

	function cancelEdit() {
		setEditingId(null);
		setEditDraft(null);
		setEditError(undefined);
	}

	function saveEdit(rule: Rule) {
		if (!editDraft) return;
		const keyError = validateRuleMatchValue(editDraft.matchType, editDraft.matchValue);
		if (keyError) {
			setEditError(keyError);
			return;
		}
		if (!editDraft.replyText.trim()) {
			setEditError("กรุณากรอกข้อความที่ต้องการให้บอทตอบกลับ");
			return;
		}
		setEditError(undefined);
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

			<form
				className="rule-form"
				onSubmit={submit}
				style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-xs)", marginBottom: "var(--space-md)" }}
			>
				<select value={surface} onChange={(e) => setSurface(e.target.value as Rule["surface"])} style={inputStyle}>
					<option value="all">ทุกประเภท (all)</option>
					<option value="talk">กลุ่มแชท (talk)</option>
					<option value="square">OpenChat (square)</option>
				</select>
				<select
					value={matchType}
					onChange={(e) => {
						setMatchType(e.target.value as Rule["matchType"]);
						setCreateError(undefined);
					}}
					style={inputStyle}
				>
					<option value="equals">ตรงทั้งหมด (equals)</option>
					<option value="startsWith">ขึ้นต้นด้วย (startsWith)</option>
					<option value="containsAny">มีคำใดคำหนึ่ง (คั่นด้วย ,)</option>
					<option value="regex">regex (ขั้นสูง)</option>
				</select>
				<input
					placeholder={RULE_MATCH_GUIDES[matchType].placeholder}
					value={matchValue}
					onChange={(e) => {
						setMatchValue(e.target.value);
						setCreateError(undefined);
					}}
					aria-invalid={createDisplayedError ? true : undefined}
					aria-describedby="rule-key-help rule-create-error"
					style={{ ...inputStyle, flex: "1 1 120px" }}
				/>
				<textarea
					placeholder="ข้อความตอบกลับ (กด Enter เพื่อขึ้นบรรทัดใหม่)"
					value={replyText}
					onChange={(e) => {
						setReplyText(e.target.value);
						setCreateError(undefined);
					}}
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
				<div id="rule-key-help" className="hint" style={{ flex: "1 0 100%", fontSize: "var(--text-xs)" }}>
					{RULE_MATCH_GUIDES[matchType].help}
				</div>
				{createDisplayedError && (
					<div id="rule-create-error" role="alert" style={validationErrorStyle}>
						{createDisplayedError}
					</div>
				)}
				{!createDisplayedError && createFeedback?.valid && (
					<div role="status" style={validationSuccessStyle}>
						{createFeedback.message}
					</div>
				)}
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
								onChange={(e) => {
									setEditDraft({ ...editDraft, matchType: e.target.value as Rule["matchType"] });
									setEditError(undefined);
								}}
								style={inputStyle}
							>
								<option value="equals">ตรงทั้งหมด (equals)</option>
								<option value="startsWith">ขึ้นต้นด้วย (startsWith)</option>
								<option value="containsAny">มีคำใดคำหนึ่ง (คั่นด้วย ,)</option>
								<option value="regex">regex (ขั้นสูง)</option>
							</select>
							<input
								placeholder={RULE_MATCH_GUIDES[editDraft.matchType].placeholder}
								value={editDraft.matchValue}
								onChange={(e) => {
									setEditDraft({ ...editDraft, matchValue: e.target.value });
									setEditError(undefined);
								}}
								aria-invalid={editDisplayedError ? true : undefined}
								style={{ ...inputStyle, flex: "1 1 120px" }}
							/>
							<textarea
								placeholder="ข้อความตอบกลับ (กด Enter เพื่อขึ้นบรรทัดใหม่)"
								value={editDraft.replyText}
								onChange={(e) => {
									setEditDraft({ ...editDraft, replyText: e.target.value });
									setEditError(undefined);
								}}
								rows={2}
								style={{ ...replyTextareaStyle, flex: "1 1 120px" }}
							/>
							<button onClick={() => saveEdit(rule)} style={saveBtnStyle}>
								บันทึก
							</button>
							<button onClick={cancelEdit} style={deleteBtnStyle}>
								ยกเลิก
							</button>
							<div className="hint" style={{ flex: "1 0 100%", fontSize: "var(--text-xs)" }}>
								{RULE_MATCH_GUIDES[editDraft.matchType].help}
							</div>
							{editDisplayedError && (
								<div role="alert" style={validationErrorStyle}>
									{editDisplayedError}
								</div>
							)}
							{!editDisplayedError && editFeedback?.valid && (
								<div role="status" style={validationSuccessStyle}>
									{editFeedback.message}
								</div>
							)}
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
							<span className="mono" style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", minWidth: 108 }}>
								{rule.surface} · {rule.matchType}
							</span>
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
					),
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

const validationErrorStyle: CSSProperties = {
	flex: "1 0 100%",
	padding: "0.5rem 0.65rem",
	border: "1px solid var(--signal-bad)",
	borderRadius: "var(--radius-sm)",
	color: "var(--signal-bad)",
	background: "color-mix(in srgb, var(--signal-bad) 8%, transparent)",
	fontSize: "var(--text-xs)",
};

const validationSuccessStyle: CSSProperties = {
	flex: "1 0 100%",
	padding: "0.5rem 0.65rem",
	border: "1px solid var(--signal-go-dim)",
	borderRadius: "var(--radius-sm)",
	color: "var(--signal-go)",
	background: "color-mix(in srgb, var(--signal-go) 8%, transparent)",
	fontSize: "var(--text-xs)",
};
