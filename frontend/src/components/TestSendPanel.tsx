import { type FormEvent, useEffect, useState } from "react";
import type { ChatRow, Surface } from "../lib/types.ts";
import { api } from "../lib/api.ts";

interface TestSendPanelProps {
	botId: number;
	selectedChats?: ChatRow[];
}

export function TestSendPanel({ botId, selectedChats = [] }: TestSendPanelProps) {
	const [surface, setSurface] = useState<Surface>("talk");
	const [targetMid, setTargetMid] = useState("");
	// เก็บข้อความไว้ใน state (RAM) — พิมพ์ครั้งเดียว พร้อมส่งซ้ำไปทุกห้องที่เลือกไว้
	const [text, setText] = useState("!ping");
	const [status, setStatus] = useState<{ ok: boolean; message: string } | undefined>();
	const [sending, setSending] = useState(false);
	const [progress, setProgress] = useState<{ done: number; total: number } | undefined>();

	// A manually-typed targetMid belongs to whichever bot was selected when
	// it was typed — switching bots without clearing it risks a test send
	// that looks targeted at the new bot but is actually a stale mid from
	// the old one. Status/progress are from a prior bot's send and stop
	// meaning anything once the bot changes too.
	useEffect(() => {
		setTargetMid("");
		setStatus(undefined);
		setProgress(undefined);
	}, [botId]);

	const hasMultiTargets = selectedChats.length > 0;

	async function submit(e: FormEvent) {
		e.preventDefault();
		if (!text.trim()) return;

		if (hasMultiTargets) {
			setSending(true);
			setStatus(undefined);
			setProgress({ done: 0, total: selectedChats.length });
			let failCount = 0;
			let done = 0;
			for (const chat of selectedChats) {
				try {
					const res = await api.testSend(botId, chat.surface, chat.mid, text);
					if (!res.ok) failCount++;
				} catch {
					failCount++;
				}
				done++;
				setProgress({ done, total: selectedChats.length });
			}
			setSending(false);
			setStatus(
				failCount === 0
					? { ok: true, message: `ส่งสำเร็จทั้งหมด ${selectedChats.length} ห้อง — ดูผลได้ที่ค่า P95 ด้านบนและบันทึกสด` }
					: { ok: false, message: `ส่งไม่สำเร็จ ${failCount}/${selectedChats.length} ห้อง` },
			);
			return;
		}

		if (!targetMid.trim()) return;
		setSending(true);
		setStatus(undefined);
		try {
			const res = await api.testSend(botId, surface, targetMid.trim(), text);
			setStatus(
				res.ok
					? { ok: true, message: "ส่งสำเร็จ — ดูผลได้ที่ค่า P95 ด้านบนและบันทึกสด" }
					: { ok: false, message: res.error ?? "ส่งไม่สำเร็จ" },
			);
		} catch (err) {
			setStatus({ ok: false, message: err instanceof Error ? err.message : String(err) });
		} finally {
			setSending(false);
		}
	}

	const inputStyle = {
		background: "var(--bg-inset)",
		border: "1px solid var(--border-hair)",
		borderRadius: "var(--radius-sm)",
		padding: "0.45rem 0.6rem",
		color: "var(--text-primary)",
		fontSize: "var(--text-sm)",
	};

	return (
		<section className="panel" style={{ padding: "var(--space-md)" }}>
			<div className="label" style={{ marginBottom: "var(--space-xs)" }}>
				ทดสอบส่งข้อความ
			</div>
			<p className="hint" style={{ margin: "0 0 var(--space-sm)" }}>
				ยิงข้อความทดสอบโดยไม่ต้องรอข้อความจริง ผลจะถูกนับรวมในค่า P95 เหมือนของจริง
			</p>

			{hasMultiTargets && (
				<div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", marginBottom: "var(--space-sm)" }}>
					{selectedChats.map((chat) => (
						<span key={chat.mid} className="chip chip--idle" style={{ fontSize: "var(--text-xs)", padding: "0.25rem 0.55rem" }}>
							{chat.surface} · {chat.name ?? chat.mid}
						</span>
					))}
				</div>
			)}

			<form onSubmit={submit} style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-xs)", alignItems: "center" }}>
				{!hasMultiTargets && (
					<>
						<select value={surface} onChange={(e) => setSurface(e.target.value as Surface)} style={inputStyle}>
							<option value="talk">กลุ่มแชท (talk)</option>
							<option value="square">OpenChat (square)</option>
						</select>
						<input
							placeholder="รหัสห้องแชท (mid)"
							value={targetMid}
							onChange={(e) => setTargetMid(e.target.value)}
							style={{ ...inputStyle, flex: "1 1 160px" }}
						/>
					</>
				)}
				<input
					placeholder="ข้อความที่จะส่ง"
					value={text}
					onChange={(e) => setText(e.target.value)}
					style={{ ...inputStyle, flex: "1 1 160px" }}
				/>
				<button
					type="submit"
					disabled={sending || (!hasMultiTargets && !targetMid.trim()) || !text.trim()}
					style={{
						background: "var(--accent-line)",
						color: "#04170c",
						border: "none",
						borderRadius: "var(--radius-sm)",
						padding: "0.45rem 1rem",
						fontWeight: 700,
						cursor: sending ? "default" : "pointer",
						opacity: sending ? 0.6 : 1,
					}}
				>
					{sending
						? hasMultiTargets && progress
							? `กำลังส่ง… (${progress.done}/${progress.total})`
							: "กำลังส่ง…"
						: hasMultiTargets
							? `ส่งไปทั้งหมด ${selectedChats.length} ห้อง`
							: "ส่งข้อความทดสอบ"}
				</button>
			</form>
			{status && (
				<div
					style={{ marginTop: "var(--space-xs)", fontSize: "var(--text-sm)", color: status.ok ? "var(--signal-go)" : "var(--signal-bad)" }}
				>
					{status.message}
				</div>
			)}
		</section>
	);
}
