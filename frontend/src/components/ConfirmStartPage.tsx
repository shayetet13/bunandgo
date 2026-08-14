import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";

interface ConfirmStartPageProps {
	token: string;
}

type ViewState = "loading" | "pending" | "accepted" | "declined" | "error";

const WARNINGS = [
	"อย่าใช้ LINE ส่วนตัวในการใช้งานบอท",
	"อย่า login/logout ที่บอทบ่อยเกินไป ควร login ค้างไว้ตลอด หากไม่ใช้งานให้กด \"หยุด\" หรือพักไว้แทน",
	"อย่าพยายามทดสอบส่งข้อความถี่เกินไป ควรเว้นช่วงอย่างน้อย 1 นาทีต่อครั้ง",
	"ก่อนใช้งานบอท ควรเข้าแอป LINE ที่จะใช้ ไปที่หน้าที่แจ้งเตือนอุปกรณ์ที่ล็อกอินอยู่ แล้วกด \"ออกจากระบบ\" อุปกรณ์อื่นให้หมด (ย้อนดูสัก 2-3 รายการ)",
	"ถ้าบอทออนไลน์อยู่ในโทรศัพท์เครื่องหนึ่งแล้ว อย่าเอาบัญชีเดียวกันไป login ซ้ำที่คอมหรืออุปกรณ์อื่น — ถ้าจำเป็นต้องทำ ให้กดออกจากระบบตามข้อ 4 ก่อนเสมอ",
	"การใช้งานบอทมีความเสี่ยงที่จะโดนแบนอยู่เสมอ ระบบแบนของ LINE ทำงานแบบอัตโนมัติ วิธีข้างต้นช่วยลดความเสี่ยงได้ แต่ไม่การันตี 100%",
];

function CloseHint() {
	const [attempted, setAttempted] = useState(false);

	function handleClose() {
		setAttempted(true);
		window.close();
	}

	return (
		<button type="button" className="confirm-start-hint confirm-start-close-btn" onClick={handleClose}>
			{attempted ? "ปิดแท็บนี้เองได้เลยด้วยปุ่มย้อนกลับ (บางเบราว์เซอร์ปิดให้อัตโนมัติไม่ได้)" : "ปิดหน้านี้ได้เลย"}
		</button>
	);
}

export function ConfirmStartPage({ token }: ConfirmStartPageProps) {
	const [view, setView] = useState<ViewState>("loading");
	const [busy, setBusy] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string>();

	useEffect(() => {
		let cancelled = false;
		api
			.getStartConfirmation(token)
			.then((result) => {
				if (!cancelled) setView(result.status);
			})
			.catch((err) => {
				if (cancelled) return;
				setErrorMessage(err instanceof Error ? err.message : String(err));
				setView("error");
			});
		return () => {
			cancelled = true;
		};
	}, [token]);

	async function accept() {
		setBusy(true);
		setErrorMessage(undefined);
		try {
			await api.acceptStartConfirmation(token);
			setView("accepted");
		} catch (err) {
			setErrorMessage(err instanceof Error ? err.message : String(err));
			setView("error");
		} finally {
			setBusy(false);
		}
	}

	async function decline() {
		setBusy(true);
		setErrorMessage(undefined);
		try {
			await api.declineStartConfirmation(token);
			setView("declined");
		} catch (err) {
			setErrorMessage(err instanceof Error ? err.message : String(err));
			setView("error");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="confirm-start-page">
			<div className="confirm-start-card">
				{view === "loading" && (
					<div className="confirm-start-result">
						<p>กำลังตรวจสอบลิงก์…</p>
					</div>
				)}

				{view === "pending" && (
					<>
						<div className="confirm-start-badge">⚠ ข้อควรระวังก่อนเริ่มใช้งานบอท</div>
						<p className="confirm-start-intro">
							การ Ban ของ LINE ทำงานเป็นระบบอัตโนมัติ — นี่คือวิธีลดความเสี่ยง แต่ก็ยังมีโอกาสโดนได้
						</p>
						<ol className="confirm-start-list">
							{WARNINGS.map((warning, index) => (
								<li key={index}>{warning}</li>
							))}
						</ol>
						<div className="confirm-start-actions">
							<button className="confirm-start-btn confirm-start-btn--accept" disabled={busy} onClick={() => void accept()}>
								{busy ? "กำลังดำเนินการ…" : "ตกลง เริ่มเชื่อมต่อ"}
							</button>
							<button className="confirm-start-btn confirm-start-btn--decline" disabled={busy} onClick={() => void decline()}>
								ยกเลิก / ออก
							</button>
						</div>
					</>
				)}

				{view === "accepted" && (
					<div className="confirm-start-result">
						<span className="confirm-start-result-icon confirm-start-result-icon--ok">✓</span>
						<h1>ยืนยันแล้ว</h1>
						<p>กลับไปที่หน้าจอเดิม (แดชบอร์ด) แล้วสแกน QR โค้ดของ LINE ที่ขึ้นมาให้ เพื่อเชื่อมต่อบอทต่อได้เลย</p>
						<CloseHint />
					</div>
				)}

				{view === "declined" && (
					<div className="confirm-start-result">
						<span className="confirm-start-result-icon confirm-start-result-icon--cancel">✕</span>
						<h1>ยกเลิกแล้ว</h1>
						<p>บอทจะยังไม่เริ่มเชื่อมต่อ กลับไปกด "เริ่ม" ใหม่ที่หน้าจอเดิมได้เมื่อพร้อม</p>
						<CloseHint />
					</div>
				)}

				{view === "error" && (
					<div className="confirm-start-result">
						<span className="confirm-start-result-icon confirm-start-result-icon--cancel">!</span>
						<h1>ทำรายการไม่สำเร็จ</h1>
						<p>{errorMessage || "ลิงก์นี้อาจไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว"}</p>
						<p className="confirm-start-hint">กลับไปที่หน้าจอเดิมแล้วลองกด "เริ่ม" ใหม่อีกครั้ง</p>
					</div>
				)}
			</div>
		</div>
	);
}
